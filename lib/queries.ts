// Read-model v4 atas HISTORY DuckDB.
// KUNCI v4: setiap query WAJIB join `wh_map` (peta location_id → kode WH dari
// config/warehouses.json). Join itu sekaligus ALLOWLIST: lokasi di luar 8 gudang
// (mis. HUB) otomatis tersaring, dan kode WH tidak lagi ditebak dari sloc_code.
// Ditambah filter `active` dan basis ketiga: BIN (SLOC terisi vs kosong).
import { historyDbVersion, queryHistory } from "@/lib/db";
import { createHash } from "node:crypto";
import { occupancyStatuses, rungFor, statusForRow } from "@/lib/occupancy";
import { hoursToTarget } from "@/lib/forecast";
import { resolveSloc, categoryCounted, countedStatuses } from "@/lib/capacity";
import type { SlocScope } from "@/lib/capacity";
import {
  getCapacity, getThresholds, getWarehouses, thresholdsFor, whMapSQL, whNameByCode,
} from "@/lib/config";
import { clearReadModelMemory, readModelCached } from "@/lib/read-model-cache";
import { CAPACITY_LIMIT_PCT, CAPACITY_MATCH_TOLERANCE_PCT } from "@/lib/alerts/severity";
import { type SlocFilter, type SlocSort } from "@/lib/sloc-filter";
import {
  EMPTY_MOVEMENT_FILTER,
  EMPTY_MOVEMENT_SUMMARY,
  RANGE_HOURS,
  movementDirectionSQL,
  movementFlowSQL,
  movementTypeSQL,
  type MovementFacets,
  type MovementFilter,
  type MovementRow,
  type MovementSort,
  type MovementSummary,
  type MovementType,
  type MovementBucket,
  type MovementWarehouseRow,
} from "@/lib/movements";
export type { MovementBucket, MovementRow, MovementSummary, MovementWarehouseRow };
import type {
  SlocOccupancy, WarehouseSummary, ZoneSummary, RackZoneSummary, TrendPoint, ForecastRow, StockLine, Basis, BasisMode,
} from "@/types";

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
// Kapasitas nominal harus dapat dicocokkan huruf-per-huruf dengan yang diketik
// admin. Empat desimal cukup untuk nilai serapat 0,0336 tanpa membulatkannya
// menjadi angka lain — justru pembulatan itulah yang membuat konfigurasi
// terlihat tidak diterapkan.
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Sidik jari data + kebijakan yang menentukan kapan read model harus dihitung
 * ulang.
 *
 * Fungsi ini dipanggil pada setiap akses read model, dan menyusunnya berarti
 * men-stringify konfigurasi kapasitas — puluhan kilobita JSON — lalu
 * mem-hash-nya. Karena `getCapacity()` dan kawan-kawan mengembalikan objek yang
 * sama persis selama berkasnya tidak berubah, identitas objek itu sendiri sudah
 * merupakan penanda perubahan yang tepat: cukup hitung ulang saat salah satu
 * referensinya benar-benar berganti.
 */
let versionMemo: {
  db: string;
  warehouses: unknown;
  capacity: unknown;
  thresholds: unknown;
  value: string;
} | null = null;

/**
 * Revisi kontrak perhitungan read model.
 *
 * Sidik jari di bawah hanya mencakup DATA dan KEBIJAKAN. Perubahan pada cara
 * menghitungnya tidak mengubah keduanya, sehingga hasil lama di
 * `db/read-model-cache/` tetap tersaji setelah deploy — persis yang akan
 * terjadi pada perbaikan tangga status ini: lokasi tepat 100% akan tetap
 * terbaca "Breach" dari cache walau kodenya sudah benar.
 *
 * Naikkan nilai ini setiap kali makna atau bentuk kolom hasil hitungan berubah.
 */
const READ_MODEL_REVISION = "2026-08-20-capacity-boundary";

function readModelVersion(): string {
  const db = String(historyDbVersion());
  const warehouses = getWarehouses();
  const capacity = getCapacity();
  const thresholds = getThresholds();
  if (
    versionMemo
    && versionMemo.db === db
    && versionMemo.warehouses === warehouses
    && versionMemo.capacity === capacity
    && versionMemo.thresholds === thresholds
  ) return versionMemo.value;
  const value = createHash("sha1")
    .update(READ_MODEL_REVISION)
    .update(db)
    .update(JSON.stringify(warehouses))
    .update(JSON.stringify(capacity))
    .update(JSON.stringify(thresholds))
    .digest("hex");
  versionMemo = { db, warehouses, capacity, thresholds, value };
  return value;
}

interface SlocMeta {
  sloc_id: number; sloc_code: string; wh: string; zone: string; rack_zone: string;
  aisle: string; bay: string; level: string; bin: string; storage: string;
  max_quantity: number; max_volume: number; location_id: number;
}

type CapacityMeta = Pick<SlocScope,
  "wh" | "zone" | "rack_zone" | "aisle" | "bay" | "level" | "bin" |
  "storage" | "max_quantity" | "max_volume">;

function capacityScope(m: CapacityMeta): SlocScope {
  return {
    wh: m.wh, zone: m.zone, rack_zone: m.rack_zone,
    aisle: m.aisle, bay: m.bay, level: m.level, bin: m.bin,
    storage: m.storage, max_quantity: m.max_quantity, max_volume: m.max_volume,
  };
}

// ---- filter bersama --------------------------------------------------------
const WH_MAP = () => `WITH ${whMapSQL()}`;
/** JOIN yang menyaring ke gudang ber-izin + memberi kode WH kanonik. */
const JOIN_WH = "JOIN wh_map m ON m.location_id = v.location_id";
/** Seluruh SLOC aktif di 8 gudang: denominator Bin warehouse yang sama dengan filter Superset. */
const ACTIVE_SLOC = `v.active
  AND nullif(trim(v.sloc_code), '') IS NOT NULL`;
/** Subset rack yang punya zona: satu-satunya yang dapat ditampilkan per-zona/heatmap. */
const OPERATIONAL_SLOC = `${ACTIVE_SLOC}
  AND nullif(trim(v.zone), '') IS NOT NULL`;

interface OccupancyScope {
  wh?: string;
  zone?: string;
  sloc?: string;
  operational?: boolean;
}

function cleanScope(scope: OccupancyScope): OccupancyScope {
  const allowed = new Set(getWarehouses().warehouses.map((w) => w.code));
  const wh = scope.wh?.trim().toUpperCase();
  return {
    wh: wh && allowed.has(wh) ? wh : undefined,
    zone: scope.zone?.trim().toUpperCase() || undefined,
    sloc: scope.sloc?.trim().toUpperCase() || undefined,
    operational: Boolean(scope.operational),
  };
}

function scopeWhere(scope: OccupancyScope, params: unknown[]): string {
  const where: string[] = [];
  if (scope.wh) { where.push("m.wh = ?"); params.push(scope.wh); }
  if (scope.zone) { where.push("v.zone = ?"); params.push(scope.zone); }
  if (scope.sloc) { where.push("v.sloc_code = ?"); params.push(scope.sloc); }
  return where.length ? ` AND ${where.join(" AND ")}` : "";
}

function scopeSlocPredicate(scope: OccupancyScope): string {
  // A selected zone is always operational. For warehouse totals, retain every
  // active SLOC so Qty/CBM/Bin agree with the source `active = true` filter.
  const base = scope.operational || scope.zone ? OPERATIONAL_SLOC : ACTIVE_SLOC;
  return `${base} AND ${zoneEnabledSQL()}`;
}

/**
 * Excludes zones an admin switched off in capacity.json.
 *
 * Applied inside the SQL WHERE clause rather than filtered in Node so the
 * numerator and denominator of every ratio are drawn from the same population
 * — a disabled zone cannot contribute stock while still contributing capacity.
 *
 * `coalesce` is not cosmetic here. Active SLOCs may legitimately have a NULL
 * zone, and `NOT (wh = 'PGS' AND zone = 'X')` evaluates to NULL for those rows,
 * which SQL treats as false in a WHERE clause. Without the coalesce this
 * predicate would drop every unzoned location from the warehouse totals.
 */
function zoneEnabledSQL(slocAlias = "v", whAlias = "m"): string {
  const disabled = getCapacity().disabled_zones;
  if (!disabled.length) return "TRUE";
  const pairs = disabled.map((entry) =>
    `(${whAlias}.wh = ${sqlString(entry.wh)} AND coalesce(${slocAlias}.zone, '') = ${sqlString(entry.zone)})`);
  return `NOT (${pairs.join(" OR ")})`;
}

function sqlList(vals: string[]): string {
  return vals.map((v) => `'${v.replace(/'/g, "''")}'`).join(",");
}
const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * ZONA WAKTU BASIS DATA RIWAYAT
 * =============================
 * SETIAP timestamp naif di history DuckDB adalah JAM DINDING WIB — bukan UTC.
 * Diverifikasi terhadap basis data ini: job `movement_incremental` selesai pada
 * `2026-08-22 14:30:38` dan berkas `.duckdb`-nya bertanggal ubah
 * `14:30:38 GMT+0700` — persis sama. Berlaku untuk `created_at`, `updated_at`,
 * `_synced_at`, dan seluruh kolom `_sync_audit`/`_sync_state`.
 *
 * Dua konsekuensinya sama-sama mudah dilanggar tanpa terlihat di mesin
 * pengembang yang jamnya kebetulan WIB, lalu meleset TUJUH JAM begitu dideploy
 * ke kontainer yang jamnya UTC:
 *
 * 1. TIMESTAMP YANG DIKIRIM KE LUAR harus lewat `wibIso()`. Binding DuckDB
 *    mengubah timestamp naif menjadi `Date` dengan menganggap jam dindingnya
 *    UTC, jadi `SELECT _synced_at` saja sudah tujuh jam terlalu awal. Bahkan
 *    `::VARCHAR` tidak menyelamatkan: `new Date("2026-08-22 14:24:59")` diurai
 *    sebagai waktu LOKAL proses yang merender — benar di laptop WIB, tujuh jam
 *    meleset di kontainer UTC.
 * 2. BATAS RENTANG WAKTU tidak boleh memakai `now()` DuckDB, yang mengembalikan
 *    UTC. Membandingkannya dengan kolom berjam WIB menggeser jendelanya tujuh
 *    jam. Batasnya dihitung di Node sebagai jam dinding WIB lalu diikat sebagai
 *    parameter — lihat `wibCutoff()`.
 *
 * Nilai `created_at` juga dikirim kembali ke Superset sebagai watermark sinkron,
 * jadi menormalkannya ke UTC di dalam basis data bukan pilihan: itu akan
 * melewatkan atau menarik ulang tujuh jam data pada setiap pass.
 */
const WIB_OFFSET = "+07:00";

/** Ekspresi SQL yang mengubah kolom timestamp naif menjadi ISO 8601 ber-offset. */
const wibIso = (column: string) =>
  `strftime(${column}, '%Y-%m-%dT%H:%M:%S') || '${WIB_OFFSET}'`;

/** Jam dinding WIB untuk sebuah instan — bentuk yang sama dengan isi kolomnya. */
function wibWallClock(at: Date): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Jakarta",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).format(at);
  // sv-SE memberi "YYYY-MM-DD HH:MM:SS" — format yang sama dengan kolomnya.
  return parts.replace("T", " ");
}

/**
 * Batas bawah jendela waktu, dalam jam dinding WIB.
 *
 * Pengganti `now() - INTERVAL n HOUR` untuk setiap kolom riwayat. Dipakai
 * sebagai parameter terikat, bukan disisipkan ke teks SQL.
 */
function wibCutoff(hoursBack: number): string {
  return wibWallClock(new Date(Date.now() - hoursBack * 3_600_000));
}

/**
 * JAM SUMBER (WMS/Superset) BERBEDA DARI JAM SINKRON
 * ==================================================
 * Dua kelompok timestamp hidup berdampingan di basis data ini, dan menyamakan
 * keduanya adalah cacat tujuh jam yang paling sulit terlihat di aplikasi ini.
 *
 *  - DITULIS OLEH PROSES SINKRON — `_synced_at`, `_sync_audit.*`,
 *    `_sync_state.updated_at`. Ini jam dinding WIB yang sebenarnya. Dibuktikan:
 *    job `movement_incremental` selesai pada `2026-08-22 14:30:38` dan berkas
 *    `.duckdb`-nya bertanggal ubah `14:30:38 GMT+0700` — identik.
 *
 *  - BERASAL DARI SUMBER — `created_at` dan `updated_at` pada `movement_events`.
 *    Nilai ini SUDAH menerima satu konversi +07:00 di hulu: WMS menyimpan jam
 *    dinding WIB, lalu lapisan di atasnya memperlakukannya sebagai UTC dan
 *    mengubahnya ke Asia/Jakarta sekali lagi. Akibatnya jam yang tersimpan
 *    berada TUJUH JAM DI DEPAN kejadian sebenarnya: baris yang tercatat
 *    `2026-08-22 14:30:10` benar-benar terjadi pukul 07.30 WIB.
 *    Dikonfirmasi terhadap WMS pada 2026-08-26.
 *
 * Perbedaan itu tidak dapat disimpulkan dari data — `max(created_at)` kebetulan
 * jatuh beberapa detik sebelum sinkron selesai, yang justru membuat keduanya
 * tampak sejam. Karena itu koreksinya ditulis eksplisit di sini, sekali, dengan
 * angka yang dapat diubah tanpa menyentuh kode.
 *
 * KOREKSINYA HANYA UNTUK TAMPILAN. Nilai di dalam basis data tidak diubah:
 * `created_at` dikirim kembali ke Superset sebagai watermark sinkron, jadi
 * menggesernya di sana akan melewatkan atau menarik ulang tujuh jam data pada
 * setiap pass.
 *
 * Bila suatu hari hulunya diperbaiki, setel `WIOM_SOURCE_CLOCK_SHIFT_HOURS=0`
 * dan seluruh aplikasi ikut menyesuaikan — tanpa deploy ulang kode.
 */
const SOURCE_CLOCK_SHIFT_HOURS = (() => {
  const raw = Number(process.env.WIOM_SOURCE_CLOCK_SHIFT_HOURS ?? "7");
  // Batas ±14 jam mencakup seluruh zona waktu nyata; nilai di luar itu hampir
  // pasti salah ketik, dan diam-diam menggeser setiap jam di layar.
  return Number.isFinite(raw) && Math.abs(raw) <= 14 ? raw : 7;
})();

/**
 * Timestamp berasal-sumber sebagai ISO ber-offset, sesudah koreksi jam hulu.
 *
 * Dipakai untuk SETIAP kolom `created_at`/`updated_at` pergerakan. Kolom milik
 * proses sinkron tetap memakai `wibIso()` — menggesernya justru akan membuat
 * "snapshot terakhir" meleset tujuh jam ke arah sebaliknya.
 */
const sourceIso = (column: string) =>
  SOURCE_CLOCK_SHIFT_HOURS === 0
    ? wibIso(column)
    : wibIso(`((${column}) - INTERVAL ${SOURCE_CLOCK_SHIFT_HOURS} HOUR)`);

/**
 * Batas bawah jendela waktu untuk kolom berasal-sumber.
 *
 * Kolomnya bergeser, jadi ambangnya harus ikut bergeser. Tanpa ini "24 jam
 * terakhir" pada halaman Pergerakan memotong jendelanya tujuh jam meleset —
 * dan pada rentang pendek itu berarti tabel tampak kosong padahal datanya ada.
 */
function sourceCutoff(hoursBack: number): string {
  return wibWallClock(
    new Date(Date.now() - hoursBack * 3_600_000 + SOURCE_CLOCK_SHIFT_HOURS * 3_600_000),
  );
}

function locationScopePredicateSQL(
  scope: {
    wh?: string; zone?: string; rack_zone?: string; aisle?: string; bay?: string;
    level?: string; bin?: string; storage?: string; l1_category?: string;
  },
  slocAlias = "v",
  whAlias = "m",
): string {
  const match = [
    scope.wh ? `${whAlias}.wh = ${sqlString(scope.wh)}` : "",
    scope.zone
      ? `(${slocAlias}.zone = ${sqlString(scope.zone)} OR ${slocAlias}.rack_zone = ${sqlString(scope.zone)})`
      : "",
    scope.rack_zone ? `${slocAlias}.rack_zone = ${sqlString(scope.rack_zone)}` : "",
    scope.aisle ? `${slocAlias}.aisle = ${sqlString(scope.aisle)}` : "",
    scope.bay ? `${slocAlias}.bay = ${sqlString(scope.bay)}` : "",
    scope.level ? `${slocAlias}.level = ${sqlString(scope.level)}` : "",
    scope.bin ? `${slocAlias}.bin = ${sqlString(scope.bin)}` : "",
    scope.storage ? `${slocAlias}.storage_handling = ${sqlString(scope.storage)}` : "",
  ].filter(Boolean);
  return match.length ? match.join(" AND ") : "TRUE";
}

/**
 * SQL mirror of resolveSloc(). Keeping validity and effective capacity in the
 * database lets aggregate numerators use exactly the same SLOC population as
 * their denominators without materialising 143k locations in Node.js.
 *
 * KENAPA CTE `effective` DITANDAI `MATERIALIZED`
 * ----------------------------------------------
 * Ekspresi yang dibangun di bawah bukan ekspresi biasa: dengan 58 aturan
 * kapasitas aktif, masing-masing `basis`, `capQty`, `capCbm`, `qtyValid`, dan
 * `cbmValid` menjadi CASE bersarang sepanjang ~6 KB teks SQL. DuckDB secara
 * bawaan MENYISIPKAN CTE ke setiap tempat ia dirujuk, dan setiap kueri okupansi
 * merujuk `effective` dua sampai tiga kali (stok, kapasitas, hitungan bin).
 * Akibatnya lima pohon CASE itu dievaluasi ulang atas 145 ribu lokasi sebanyak
 * jumlah rujukannya — pekerjaan yang hasilnya persis sama setiap kali.
 *
 * `AS MATERIALIZED` hanyalah petunjuk perencana: ia memaksa CTE dihitung sekali
 * lalu dipakai bersama, dan tidak mengubah satu baris pun hasilnya (diverifikasi
 * dengan membandingkan jawaban JSON /api/sloc/explore, /api/occupancy/heatmap,
 * dan /api/occupancy/zone-detail sebelum dan sesudah — identik byte per byte).
 *
 * Tandanya sengaja TIDAK dipasang pada tren dan laju aliran: keduanya merujuk
 * `effective` sekali lalu men-join-nya ke `stock_history`, dan memaksa
 * materialisasi di sana justru menutup jalan bagi DuckDB mendorong filter waktu
 * ke bawah join.
 */
interface CapacitySqlExpressions {
  basis: string; capQty: string; capCbm: string; capCbmNominal: string;
  utilization: string; qtyValid: string; cbmValid: string;
}

/**
 * Ekspresi ini berupa CASE bersarang sepanjang jumlah aturan kapasitas, dan
 * setiap kueri okupansi membangunnya lagi dari awal. Hasilnya hanya bergantung
 * pada isi konfigurasi dan pasangan alias, jadi disimpan selama objek
 * konfigurasinya belum berganti — sekali per perubahan kebijakan, bukan sekali
 * per kueri.
 */
const capacitySqlMemo = new Map<string, { config: unknown; value: CapacitySqlExpressions }>();

function capacitySqlExpressions(slocAlias = "v", whAlias = "m"): CapacitySqlExpressions {
  const cfg = getCapacity();
  const memoKey = `${slocAlias}|${whAlias}`;
  const memo = capacitySqlMemo.get(memoKey);
  if (memo && memo.config === cfg) return memo.value;
  const built = buildCapacitySqlExpressions(cfg, slocAlias, whAlias);
  capacitySqlMemo.set(memoKey, { config: cfg, value: built });
  return built;
}

function buildCapacitySqlExpressions(
  cfg: ReturnType<typeof getCapacity>,
  slocAlias: string,
  whAlias: string,
): CapacitySqlExpressions {
  let basis = sqlString(cfg.basis_default);
  let utilization = String(cfg.utilization_pct);
  let maxQty = `coalesce(${slocAlias}.max_quantity, 0)`;
  let maxCbm = `coalesce(${slocAlias}.max_volume, 0)`;
  let qtyOverridden = "FALSE";
  let cbmOverridden = "FALSE";
  for (const rule of cfg.rules) {
    if (rule.scope.l1_category) continue;
    const match = locationScopePredicateSQL(rule.scope, slocAlias, whAlias);
    if (rule.set.basis) {
      basis = `(CASE WHEN ${match} THEN ${sqlString(rule.set.basis)} ELSE ${basis} END)`;
    }
    if (rule.set.utilization_pct !== undefined) {
      utilization = `(CASE WHEN ${match} THEN ${Number(rule.set.utilization_pct)} ELSE ${utilization} END)`;
    }
    if (rule.set.max_qty !== undefined) {
      maxQty = `(CASE WHEN ${match} THEN ${Number(rule.set.max_qty)} ELSE ${maxQty} END)`;
      qtyOverridden = `(${qtyOverridden} OR (${match}))`;
    }
    if (rule.set.max_cbm !== undefined) {
      maxCbm = `(CASE WHEN ${match} THEN ${Number(rule.set.max_cbm)} ELSE ${maxCbm} END)`;
      cbmOverridden = `(${cbmOverridden} OR (${match}))`;
    }
  }
  return {
    basis,
    capQty: `greatest(0, ${maxQty})`,
    capCbm: `greatest(0, ${maxCbm}) * (${utilization} / 100.0)`,
    // Angka apa adanya dari konfigurasi, tanpa faktor utilisasi. Dipakai layar
    // detail agar admin dapat mencocokkan langsung dengan yang ia ketik.
    capCbmNominal: `greatest(0, ${maxCbm})`,
    utilization: `(${utilization})`,
    qtyValid: `(${qtyOverridden} OR coalesce(${slocAlias}.max_quantity, 0) > 1)`,
    cbmValid: `(${cbmOverridden} OR coalesce(${slocAlias}.max_volume, 0) > 1)`,
  };
}

function categoryPredicateSQL(col: string, slocAlias = "v", whAlias = "m"): string {
  const cfg = getCapacity();
  const excl = new Set(cfg.exclude_categories);
  let predicate = excl.size ? `coalesce(${col}, '') NOT IN (${sqlList([...excl])})` : "TRUE";
  // Preserve the same ordered override semantics as categoryCounted(). This is
  // important for history/forecast: a category scoped to one WH/zone must not
  // be counted there while being excluded from the live occupancy calculation.
  for (const r of cfg.rules) {
    if (!r.scope.l1_category || r.set.count === undefined) continue;
    const match = [
      `coalesce(${col}, '') = '${r.scope.l1_category.replace(/'/g, "''")}'`,
      r.scope.wh ? `${whAlias}.wh = '${r.scope.wh.replace(/'/g, "''")}'` : "",
      r.scope.zone ? `(${slocAlias}.zone = '${r.scope.zone.replace(/'/g, "''")}' OR ${slocAlias}.rack_zone = '${r.scope.zone.replace(/'/g, "''")}')` : "",
      r.scope.rack_zone ? `${slocAlias}.rack_zone = '${r.scope.rack_zone.replace(/'/g, "''")}'` : "",
      r.scope.aisle ? `${slocAlias}.aisle = '${r.scope.aisle.replace(/'/g, "''")}'` : "",
      r.scope.bay ? `${slocAlias}.bay = '${r.scope.bay.replace(/'/g, "''")}'` : "",
      r.scope.level ? `${slocAlias}.level = '${r.scope.level.replace(/'/g, "''")}'` : "",
      r.scope.bin ? `${slocAlias}.bin = '${r.scope.bin.replace(/'/g, "''")}'` : "",
      r.scope.storage ? `${slocAlias}.storage_handling = '${r.scope.storage.replace(/'/g, "''")}'` : "",
    ].filter(Boolean).join(" AND ");
    predicate = `(CASE WHEN ${match} THEN ${r.set.count ? "TRUE" : "FALSE"} ELSE ${predicate} END)`;
  }
  return predicate;
}
const statusPredicateSQL = (col: string) =>
  `${col} IN (${sqlList([...countedStatuses()])})`;

// ---- cache ringan -----------------------------------------------------------
const occCache = new Map<string, { at: number; rows: SlocOccupancy[] }>();
const heatPreviewCache = new Map<string, { at: number; data: Record<string, SlocOccupancy[]> }>();
const TTL = 20_000;
// Source snapshots refresh every ten minutes. A five-minute server cache cuts
// repeated DuckDB scans while keeping the UI inside one half-refresh window.
const DASHBOARD_TTL = 300_000;
let cacheHistoryVersion = historyDbVersion();

function setBoundedCache<K, V>(cache: Map<K, V>, key: K, value: V, maxEntries: number) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Called after an admin policy change so the next request uses it immediately. */
export function invalidateOccupancyReadCaches(): void {
  occCache.clear();
  heatPreviewCache.clear();
  zoneCache.clear();
  warehouseBaseCache = null;
  clearReadModelMemory();
  // Memo di bawah sudah membandingkan identitas objek konfigurasi, jadi ia
  // batal dengan sendirinya. Dibersihkan di sini juga supaya satu pemanggilan
  // benar-benar mengembalikan proses ke keadaan tanpa turunan yang tersimpan.
  capacitySqlMemo.clear();
  movementAggregateCache.clear();
  versionMemo = null;
  cacheHistoryVersion = historyDbVersion();
}

function refreshCachesForHistoryChange(): void {
  if (historyDbVersion() !== cacheHistoryVersion) invalidateOccupancyReadCaches();
}

async function getSlocMeta(scope: OccupancyScope): Promise<SlocMeta[]> {
  const params: unknown[] = [];
  return queryHistory<SlocMeta>(
    `${WH_MAP()}
     SELECT v.sloc_id, v.sloc_code, m.wh, v.zone, v.rack_zone, v.aisle, v.bay, v.level, v.bin,
            v.storage_handling AS storage, v.max_quantity, v.max_volume, v.location_id
     FROM vw_sloc v ${JOIN_WH}
     WHERE ${scopeSlocPredicate(scope)}${scopeWhere(scope, params)}`,
    params
  );
}

export async function getSlocOccupancy(input: OccupancyScope = {}): Promise<SlocOccupancy[]> {
  refreshCachesForHistoryChange();
  const scope = cleanScope(input);
  // Invalid code must never silently expand the scope to all warehouses.
  if (input.wh && !scope.wh) return [];
  const key = `${scope.wh ?? "*"}|${scope.zone ?? "*"}|${scope.sloc ?? "*"}|${scope.operational || scope.zone ? "operational" : "active"}`;
  const cached = occCache.get(key);
  if (cached && Date.now() - cached.at < TTL) return cached.rows;

  const meta = await getSlocMeta(scope);
  const params: unknown[] = [];
  const agg = await queryHistory<{
    location_id: number; sloc_code: string; l1: string; qty: number; cbm: number; pc: number;
  }>(
    `${WH_MAP()}
     SELECT s.location_id, s.sloc_code, coalesce(s.l1_category,'') AS l1,
            sum(s.stock_qty)::DOUBLE AS qty, sum(s.occupied_cbm)::DOUBLE AS cbm,
            count(DISTINCT s.product_id)::INT AS pc
     FROM vw_stock_latest s
     JOIN vw_sloc v ON v.location_id = s.location_id AND v.sloc_code = s.sloc_code ${JOIN_WH}
     WHERE ${scopeSlocPredicate(scope)} AND ${statusPredicateSQL("s.status")}${scopeWhere(scope, params)}
     GROUP BY 1, 2, 3`,
    params
  );
  const keyFor = (locationId: number, slocCode: string) => `${locationId}|${slocCode}`;
  const byCode = new Map<string, { qty: number; cbm: number; pc: number }>();
  const metaByCode = new Map(meta.map((m) => [keyFor(m.location_id, m.sloc_code), m]));
  for (const a of agg) {
    const key = keyFor(a.location_id, a.sloc_code);
    const m = metaByCode.get(key);
    if (!m) continue; // lokasi di luar allowlist / non-aktif
    if (!categoryCounted(a.l1, capacityScope(m))) continue;
    const cur = byCode.get(key) ?? { qty: 0, cbm: 0, pc: 0 };
    cur.qty += a.qty; cur.cbm += a.cbm; cur.pc += a.pc;
    byCode.set(key, cur);
  }
  const rows: SlocOccupancy[] = meta.map((m) => {
    const eff = resolveSloc(capacityScope(m));
    const o = byCode.get(keyFor(m.location_id, m.sloc_code)) ?? { qty: 0, cbm: 0, pc: 0 };
    const pq = eff.qty_valid && eff.cap_qty > 0 ? (o.qty / eff.cap_qty) * 100 : null;
    const pv = eff.cbm_valid && eff.cap_cbm > 0 ? (o.cbm / eff.cap_cbm) * 100 : null;
    const pct = (eff.basis === "qty" ? pq : pv) ?? (eff.basis === "qty" ? pv : pq) ?? 0;
    const occupied = o.qty > 0 || o.cbm > 0;
    return {
      sloc_id: m.sloc_id, sloc_code: m.sloc_code, wh: m.wh, zone: m.zone, rack_zone: m.rack_zone,
      aisle: m.aisle, bay: m.bay, level: m.level, bin: m.bin, storage: m.storage,
      basis: eff.basis,
      occ_qty: r1(o.qty), cap_qty: r1(eff.cap_qty),
      occ_cbm: r3(o.cbm), cap_cbm: r3(eff.cap_cbm),
      cap_cbm_nominal: r4(eff.cap_cbm_nominal), utilization_pct: eff.utilization_pct,
      qty_valid: eff.qty_valid, cbm_valid: eff.cbm_valid,
      pct_qty: pq === null ? null : r1(pq),
      pct_cbm: pv === null ? null : r1(pv),
      occupied, pct_bin: occupied ? 100 : 0,
      pct: r1(pct),
      ...occupancyStatuses({ pct_qty: pq, pct_cbm: pv }, pct, m.wh),
      // Cell-level Bin is categorical (empty/occupied), not a 0–100 capacity ladder.
      status_bin: "NORMAL",
      product_count: o.pc,
    };
  });
  setBoundedCache(occCache, key, { at: Date.now(), rows }, 10);
  return rows;
}

interface WarehouseAggregateRow {
  wh: string; cap_qty: number; cap_cbm: number; n_cbm: number; total: number;
  qty: number; cbm: number; filled: number;
}
interface WarehouseBase {
  location_id: number; code: string; name: string; basis: Basis;
  occ_qty: number; cap_qty: number; occ_cbm: number; cap_cbm: number;
  pct: number; pct_qty: number | null; pct_cbm: number | null; pct_bin: number;
  status: import("@/types").OccupancyStatus;
  status_qty: import("@/types").OccupancyStatus | null;
  status_cbm: import("@/types").OccupancyStatus | null;
  status_bin: import("@/types").OccupancyStatus;
  sloc_total: number; sloc_occupied: number; sloc_empty: number;
}
let warehouseBaseCache: { at: number; rows: WarehouseBase[] } | null = null;
let warehouseBaseInFlight: Promise<WarehouseBase[]> | null = null;

/** Small read model for warehouse cards/trends; never materialises 143k SLOCs. */
async function loadWarehouseBase(): Promise<WarehouseBase[]> {
  refreshCachesForHistoryChange();
  if (warehouseBaseCache && Date.now() - warehouseBaseCache.at < DASHBOARD_TTL) return warehouseBaseCache.rows;
  if (warehouseBaseInFlight) return warehouseBaseInFlight;
  warehouseBaseInFlight = (async () => {
    const cap = capacitySqlExpressions();
    const aggregateRows = await queryHistory<WarehouseAggregateRow>(
      `${WH_MAP()}, effective AS MATERIALIZED (
         SELECT v.sloc_id, v.location_id, v.sloc_code, m.wh,
                coalesce(v.zone, '') AS zone, coalesce(v.rack_zone, '') AS rack_zone,
                coalesce(v.aisle, '') AS aisle, coalesce(v.bay, '') AS bay,
                coalesce(v.level, '') AS level, coalesce(v.bin, '') AS bin,
                coalesce(v.storage_handling, '') AS storage_handling,
                ${cap.basis} AS basis, ${cap.capQty} AS cap_qty, ${cap.capCbm} AS cap_cbm,
                ${cap.qtyValid} AS qty_valid, ${cap.cbmValid} AS cbm_valid
         FROM vw_sloc v ${JOIN_WH}
         WHERE ${ACTIVE_SLOC} AND ${zoneEnabledSQL()}
       ), capacities AS (
         SELECT wh,
                sum(CASE WHEN qty_valid THEN cap_qty ELSE 0 END)::DOUBLE AS cap_qty,
                sum(CASE WHEN cbm_valid THEN cap_cbm ELSE 0 END)::DOUBLE AS cap_cbm,
                sum(CASE WHEN basis = 'cbm' THEN 1 ELSE 0 END)::INT AS n_cbm,
                count(*)::INT AS total
         FROM effective GROUP BY wh
       ), stock AS (
         SELECT e.wh,
                coalesce(sum(CASE WHEN e.qty_valid THEN s.stock_qty ELSE 0 END), 0)::DOUBLE AS qty,
                coalesce(sum(CASE WHEN e.cbm_valid THEN s.occupied_cbm ELSE 0 END), 0)::DOUBLE AS cbm
         FROM effective e
         JOIN vw_stock_latest s
           ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
         WHERE ${statusPredicateSQL("s.status")}
           AND ${categoryPredicateSQL("s.l1_category", "e", "e")}
         GROUP BY e.wh
       ), filled AS (
         SELECT e.wh,
                count(DISTINCT CASE
                  WHEN s.stock_qty > 0 OR s.occupied_cbm > 0 THEN e.sloc_id
                END)::INT AS filled
         FROM effective e
         JOIN vw_stock_latest s
           ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
         WHERE ${statusPredicateSQL("s.status")}
           AND ${categoryPredicateSQL("s.l1_category", "e", "e")}
         GROUP BY e.wh
       )
       SELECT c.wh, c.cap_qty, c.cap_cbm, c.n_cbm, c.total,
              coalesce(s.qty, 0)::DOUBLE AS qty, coalesce(s.cbm, 0)::DOUBLE AS cbm,
              coalesce(f.filled, 0)::INT AS filled
       FROM capacities c
       LEFT JOIN stock s USING (wh)
       LEFT JOIN filled f USING (wh)
       ORDER BY c.wh`,
    );
    const names = whNameByCode();
    const locIds = new Map(getWarehouses().warehouses.map((w) => [w.code, w.location_id]));
    const rows = aggregateRows.map((a) => {
      const basis: Basis = a.n_cbm > a.total / 2 ? "cbm" : "qty";
      const pq = a.cap_qty > 0 ? (a.qty / a.cap_qty) * 100 : null;
      const pv = a.cap_cbm > 0 ? (a.cbm / a.cap_cbm) * 100 : null;
      const pb = a.total > 0 ? (a.filled / a.total) * 100 : 0;
      const pct = (basis === "qty" ? pq : pv) ?? (basis === "qty" ? pv : pq) ?? 0;
      return {
        location_id: locIds.get(a.wh) ?? 0, code: a.wh, name: names.get(a.wh) ?? a.wh, basis,
        occ_qty: Math.round(a.qty), cap_qty: Math.round(a.cap_qty),
        occ_cbm: r1(a.cbm), cap_cbm: r1(a.cap_cbm),
        pct: r1(pct), pct_qty: pq === null ? null : r1(pq), pct_cbm: pv === null ? null : r1(pv), pct_bin: r1(pb),
        ...occupancyStatuses({ pct_qty: pq, pct_cbm: pv }, pct, a.wh),
        // Bin adalah rasio lokasi terisi terhadap total; ia tidak pernah dapat
        // melewati 100%, jadi tangga satu-basis memang tempatnya.
        status_bin: rungFor(pb, a.wh),
        sloc_total: a.total, sloc_occupied: a.filled, sloc_empty: a.total - a.filled,
      } satisfies WarehouseBase;
    }).sort((a, b) => a.code.localeCompare(b.code));
    warehouseBaseCache = { at: Date.now(), rows };
    return rows;
  })().finally(() => { warehouseBaseInFlight = null; });
  return warehouseBaseInFlight;
}

async function getWarehouseBase(): Promise<WarehouseBase[]> {
  return readModelCached(
    "warehouse-base-v1",
    readModelVersion(),
    loadWarehouseBase,
    { freshMs: DASHBOARD_TTL },
  );
}

/**
 * Lintasan okupansi + laju per gudang, disusun dari PERGERAKAN.
 *
 * Satu sumber untuk grafik tren di Ringkasan, kolom "→ 95%", halaman Proyeksi,
 * dan simulator What-If. Sebelumnya ketiganya bergantung pada deretan snapshot
 * stok — dan tabel snapshot pada instalasi ini selalu berisi SATU snapshot,
 * sehingga semuanya diam-diam mati: grafiknya berupa titik tunggal, lajunya
 * nol, dan horizonnya selalu "—". Tidak ada satu pun pesan di layar yang
 * menjelaskan bahwa riwayatnya memang tidak akan pernah datang.
 *
 * Lihat loadMovementFlowSeries() untuk alasan lengkapnya.
 */
interface WarehouseProjection {
  trail: TrendPoint[];
  /** Unit per jam, rata-rata jendela laju. */
  in_per_hour: number;
  out_per_hour: number;
  net_per_hour: number;
  /** Δ okupansi %/jam pada basis kebijakan gudang. */
  rate_pct_per_hour: number;
  buckets: number;
  span_hours: number;
  ready: boolean;
}

async function loadWarehouseProjections(): Promise<Map<string, WarehouseProjection>> {
  const [base, series] = await Promise.all([
    getWarehouseBase(),
    loadMovementFlowSeries(FORECAST_WINDOW_HOURS),
  ]);
  const byWarehouse = new Map<string, MovementFlowBucket[]>();
  for (const bucket of series) {
    const list = byWarehouse.get(bucket.wh);
    if (list) list.push(bucket);
    else byWarehouse.set(bucket.wh, [bucket]);
  }

  const projections = new Map<string, WarehouseProjection>();
  for (const warehouse of base) {
    const buckets = (byWarehouse.get(warehouse.code) ?? [])
      .slice()
      .sort((a, b) => a.t.localeCompare(b.t));

    // Rata-rata m³ per unit pada isi gudang saat ini. Pergerakan hanya membawa
    // jumlah unit, jadi ini satu-satunya jembatan ke basis CBM — jujur selama
    // bauran produknya tidak berubah drastis dalam rentang jendela.
    const cbmPerUnit = warehouse.occ_qty > 0 ? warehouse.occ_cbm / warehouse.occ_qty : 0;
    const capBasis = warehouse.basis === "qty" ? warehouse.cap_qty : warehouse.cap_cbm;
    const toBasis = (qty: number) => (warehouse.basis === "qty" ? qty : qty * cbmPerUnit);

    // Disusun MUNDUR dari keadaan sekarang: isi pada akhir jam ke-k adalah isi
    // sekarang dikurangi seluruh perubahan bersih sesudah jam itu. Titik
    // terakhirnya karena itu selalu sama persis dengan angka okupansi yang
    // tampil di halaman lain — proyeksi tidak boleh berangkat dari titik yang
    // berbeda dengan kenyataan.
    const trail: TrendPoint[] = [];
    let runningQty = warehouse.occ_qty;
    let runningCbm = warehouse.occ_cbm;
    for (let index = buckets.length - 1; index >= 0; index -= 1) {
      const bucket = buckets[index];
      const pctQty = warehouse.cap_qty > 0 ? r1((runningQty / warehouse.cap_qty) * 100) : null;
      const pctCbm = warehouse.cap_cbm > 0 ? r1((runningCbm / warehouse.cap_cbm) * 100) : null;
      trail.unshift({
        t: bucket.t,
        warehouse: warehouse.code,
        pct: (warehouse.basis === "qty" ? pctQty : pctCbm) ?? pctQty ?? pctCbm ?? 0,
        pct_qty: pctQty,
        pct_cbm: pctCbm,
        qty: Math.round(runningQty),
      });
      const net = bucket.qty_in - bucket.qty_out;
      runningQty -= net;
      runningCbm -= net * cbmPerUnit;
    }

    const recent = buckets.slice(-RATE_LOOKBACK_HOURS);
    const hours = recent.length || 1;
    const inPerHour = recent.reduce((sum, b) => sum + b.qty_in, 0) / hours;
    const outPerHour = recent.reduce((sum, b) => sum + b.qty_out, 0) / hours;
    const netPerHour = inPerHour - outPerHour;
    // Tiga jam pergerakan adalah batas paling longgar yang masih dapat
    // membedakan tren dari satu kejadian tunggal.
    const ready = buckets.length >= 3 && capBasis > 0;
    const spanHours = buckets.length >= 2
      ? (new Date(buckets[buckets.length - 1].t).getTime() - new Date(buckets[0].t).getTime()) / 3_600_000
      : 0;

    projections.set(warehouse.code, {
      trail,
      in_per_hour: inPerHour,
      out_per_hour: outPerHour,
      net_per_hour: netPerHour,
      rate_pct_per_hour: capBasis > 0 ? (toBasis(netPerHour) / capBasis) * 100 : 0,
      buckets: buckets.length,
      span_hours: spanHours,
      ready,
    });
  }
  return projections;
}

async function getWarehouseProjections(): Promise<Map<string, WarehouseProjection>> {
  const entries = await readModelCached(
    "warehouse-projection-v1",
    readModelVersion(),
    async () => [...(await loadWarehouseProjections()).entries()],
    { freshMs: DASHBOARD_TTL },
  );
  return new Map(entries);
}

function withWarehouseTrend(
  base: Array<WarehouseBase | WarehouseSummary>,
  projections: Map<string, WarehouseProjection>,
): WarehouseSummary[] {
  return base.map((w) => {
    const projection = projections.get(w.code);
    const ready = Boolean(projection?.ready);
    const rate = ready ? projection!.rate_pct_per_hour : 0;
    return {
      ...w,
      rate_pct_per_hour: r3(rate),
      hours_to_95: ready ? hoursToTarget(w.pct, rate, 95) : null,
      hours_to_100: ready ? hoursToTarget(w.pct, rate, 100) : null,
    };
  });
}

export async function getWarehouseDashboard(): Promise<{
  summaries: WarehouseSummary[];
  trend: TrendPoint[];
}> {
  const [base, projections] = await Promise.all([getWarehouseBase(), getWarehouseProjections()]);
  const trend = [...projections.values()].flatMap((projection) => projection.trail);
  return { summaries: withWarehouseTrend(base, projections), trend };
}

export async function getWarehouseSummaries(): Promise<WarehouseSummary[]> {
  return (await getWarehouseDashboard()).summaries;
}

/** Occupancy screens that do not show forecast should not scan stock history. */
export async function getWarehouseOccupancySummary(): Promise<WarehouseSummary[]> {
  return (await getWarehouseBase()).map((warehouse) => ({
    ...warehouse,
    rate_pct_per_hour: 0,
    hours_to_95: null,
    hours_to_100: null,
  }));
}

/**
 * Makes the active-vs-zoned distinction explicit instead of silently losing
 * master-data exceptions. Warehouse totals use `active=true`; zone/heatmap
 * only use the zoned subset because an empty zone is not an operational zone.
 */
export interface OccupancyScopeQuality {
  warehouse: string;
  active_sloc: number;
  zoned_sloc: number;
  active_without_zone: number;
  /** Active locations sitting in a zone an admin switched off for occupancy. */
  disabled_zone_sloc: number;
  stock_without_operational_sloc: number;
}
async function loadOccupancyScopeQuality(): Promise<OccupancyScopeQuality[]> {
  return queryHistory<OccupancyScopeQuality>(
    // active_sloc and zoned_sloc deliberately mirror the occupancy denominators,
    // so a disabled zone leaves them. It is counted separately instead of
    // disappearing: an operator comparing this against the master data has to be
    // able to see where the difference went.
    `${WH_MAP()}, master AS (
       SELECT m.wh AS warehouse,
              count(*) FILTER (WHERE ${ACTIVE_SLOC} AND ${zoneEnabledSQL()})::INT AS active_sloc,
              count(*) FILTER (WHERE ${OPERATIONAL_SLOC} AND ${zoneEnabledSQL()})::INT AS zoned_sloc,
              count(*) FILTER (WHERE ${ACTIVE_SLOC} AND nullif(trim(v.zone), '') IS NULL)::INT AS active_without_zone,
              count(*) FILTER (WHERE ${ACTIVE_SLOC} AND NOT (${zoneEnabledSQL()}))::INT AS disabled_zone_sloc
       FROM vw_sloc v ${JOIN_WH}
       GROUP BY 1
     ), stock_exception AS (
       SELECT m.wh AS warehouse,
              count(*) FILTER (WHERE v.sloc_code IS NULL OR NOT (${OPERATIONAL_SLOC}))::INT AS stock_without_operational_sloc
       FROM vw_stock_latest s
       JOIN wh_map m ON m.location_id = s.location_id
       LEFT JOIN vw_sloc v ON v.sloc_code = s.sloc_code AND v.location_id = s.location_id
       GROUP BY 1
     )
     SELECT master.warehouse, master.active_sloc, master.zoned_sloc,
            master.active_without_zone, master.disabled_zone_sloc,
            coalesce(stock_exception.stock_without_operational_sloc, 0)::INT AS stock_without_operational_sloc
     FROM master LEFT JOIN stock_exception USING (warehouse)
     ORDER BY 1`
  );
}

interface ZoneAggregateRow {
  wh: string; zone: string; rack_zone: string; storage: string;
  cap_qty: number; cap_cbm: number; n_cbm: number; total: number;
  qty: number; cbm: number; filled: number;
}
const zoneCache = new Map<string, { at: number; rows: ZoneSummary[] }>();
const naturalOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function summarizeRackZone(row: ZoneAggregateRow): RackZoneSummary {
  const basis: Basis = row.n_cbm > row.total / 2 ? "cbm" : "qty";
  const pq = row.cap_qty > 0 ? (row.qty / row.cap_qty) * 100 : null;
  const pv = row.cap_cbm > 0 ? (row.cbm / row.cap_cbm) * 100 : null;
  const pb = row.total > 0 ? (row.filled / row.total) * 100 : 0;
  const pct = (basis === "qty" ? pq : pv) ?? (basis === "qty" ? pv : pq) ?? 0;
  return {
    wh: row.wh, zone: row.zone, rack_zone: row.rack_zone, storage: row.storage, basis,
    occ_qty: Math.round(row.qty), cap_qty: Math.round(row.cap_qty),
    occ_cbm: r1(row.cbm), cap_cbm: r1(row.cap_cbm),
    pct: r1(pct), pct_qty: pq === null ? null : r1(pq), pct_cbm: pv === null ? null : r1(pv),
    pct_bin: r1(pb), sloc_total: row.total, sloc_occupied: row.filled,
    sloc_empty: row.total - row.filled,
    ...occupancyStatuses({ pct_qty: pq, pct_cbm: pv }, pct, row.wh),
    status_bin: rungFor(pb, row.wh),
  };
}

/**
 * Zone cards deliberately do not call getSlocOccupancy(). CBT alone has about
 * 98k racks, and materialising every rack just to draw 15 zone cards made the
 * heatmap wait many seconds. Capacity is resolved from grouped master rows;
 * DuckDB aggregates counted stock and occupied bins at source.
 */
async function loadZoneSummary(wh?: string): Promise<ZoneSummary[]> {
  refreshCachesForHistoryChange();
  const scope = cleanScope({ wh, operational: true });
  if (wh && !scope.wh) return [];
  const cacheKey = scope.wh ?? "*";
  const cached = zoneCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DASHBOARD_TTL) return cached.rows;

  const params: unknown[] = [];
  const cap = capacitySqlExpressions();
  const rows = await queryHistory<ZoneAggregateRow>(
    `${WH_MAP()}, effective AS MATERIALIZED (
       SELECT v.sloc_id, v.location_id, v.sloc_code, m.wh, v.zone,
              coalesce(v.rack_zone, '') AS rack_zone, coalesce(v.aisle, '') AS aisle,
              coalesce(v.bay, '') AS bay, coalesce(v.level, '') AS level,
              coalesce(v.bin, '') AS bin, coalesce(v.storage_handling, '') AS storage_handling,
              ${cap.basis} AS basis, ${cap.capQty} AS cap_qty, ${cap.capCbm} AS cap_cbm,
              ${cap.qtyValid} AS qty_valid, ${cap.cbmValid} AS cbm_valid
       FROM vw_sloc v ${JOIN_WH}
       WHERE ${scopeSlocPredicate(scope)}${scopeWhere(scope, params)}
     ), capacities AS (
       SELECT wh, zone, rack_zone, coalesce(max(nullif(storage_handling, '')), '') AS storage,
              sum(CASE WHEN qty_valid THEN cap_qty ELSE 0 END)::DOUBLE AS cap_qty,
              sum(CASE WHEN cbm_valid THEN cap_cbm ELSE 0 END)::DOUBLE AS cap_cbm,
              sum(CASE WHEN basis = 'cbm' THEN 1 ELSE 0 END)::INT AS n_cbm,
              count(*)::INT AS total
       FROM effective GROUP BY wh, zone, rack_zone
     ), stock AS (
       SELECT e.wh, e.zone, e.rack_zone,
              coalesce(sum(CASE WHEN e.qty_valid THEN s.stock_qty ELSE 0 END), 0)::DOUBLE AS qty,
              coalesce(sum(CASE WHEN e.cbm_valid THEN s.occupied_cbm ELSE 0 END), 0)::DOUBLE AS cbm
       FROM effective e
       JOIN vw_stock_latest s
         ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
       WHERE ${statusPredicateSQL("s.status")}
         AND ${categoryPredicateSQL("s.l1_category", "e", "e")}
       GROUP BY e.wh, e.zone, e.rack_zone
     ), filled AS (
       SELECT e.wh, e.zone, e.rack_zone,
              count(DISTINCT CASE
                WHEN s.stock_qty > 0 OR s.occupied_cbm > 0 THEN e.sloc_id
              END)::INT AS filled
       FROM effective e
       JOIN vw_stock_latest s
         ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
       WHERE ${statusPredicateSQL("s.status")}
         AND ${categoryPredicateSQL("s.l1_category", "e", "e")}
       GROUP BY e.wh, e.zone, e.rack_zone
     )
     SELECT c.wh, c.zone, c.rack_zone, c.storage, c.cap_qty, c.cap_cbm, c.n_cbm, c.total,
            coalesce(s.qty, 0)::DOUBLE AS qty, coalesce(s.cbm, 0)::DOUBLE AS cbm,
            coalesce(f.filled, 0)::INT AS filled
     FROM capacities c
     LEFT JOIN stock s USING (wh, zone, rack_zone)
     LEFT JOIN filled f USING (wh, zone, rack_zone)
     ORDER BY c.wh, c.zone, c.rack_zone`,
    params,
  );

  const grouped = new Map<string, ZoneAggregateRow & { rack_zones: RackZoneSummary[]; storages: Set<string> }>();
  for (const row of rows) {
    const key = `${row.wh}|${row.zone}`;
    const group = grouped.get(key) ?? {
      wh: row.wh, zone: row.zone, rack_zone: "", storage: "",
      cap_qty: 0, cap_cbm: 0, n_cbm: 0, total: 0, qty: 0, cbm: 0, filled: 0,
      rack_zones: [], storages: new Set<string>(),
    };
    group.cap_qty += row.cap_qty;
    group.cap_cbm += row.cap_cbm;
    group.n_cbm += row.n_cbm;
    group.total += row.total;
    group.qty += row.qty;
    group.cbm += row.cbm;
    group.filled += row.filled;
    if (row.storage) group.storages.add(row.storage);
    group.rack_zones.push(summarizeRackZone(row));
    grouped.set(key, group);
  }
  const out = [...grouped.values()].map((group) => {
    group.storage = [...group.storages].sort(naturalOrder.compare).join(" · ");
    const { rack_zone: _rackZone, ...summary } = summarizeRackZone(group);
    return {
      ...summary,
      rack_zones: group.rack_zones.sort((a, b) => naturalOrder.compare(a.rack_zone, b.rack_zone)),
    } satisfies ZoneSummary;
  }).sort((a, b) => naturalOrder.compare(a.wh, b.wh) || naturalOrder.compare(a.zone, b.zone));
  setBoundedCache(zoneCache, cacheKey, { at: Date.now(), rows: out }, 10);
  return out;
}

export async function getZoneSummary(wh?: string): Promise<ZoneSummary[]> {
  const scope = cleanScope({ wh });
  if (wh && !scope.wh) return [];
  return readModelCached(
    `zone-summary-v1-${scope.wh ?? "all"}`,
    readModelVersion(),
    () => loadZoneSummary(scope.wh),
    { freshMs: DASHBOARD_TTL },
  );
}

export async function getOccupancyScopeQuality(): Promise<OccupancyScopeQuality[]> {
  return readModelCached(
    "occupancy-scope-quality-v1",
    readModelVersion(),
    loadOccupancyScopeQuality,
    { freshMs: DASHBOARD_TTL },
  );
}

export async function getHeatmap(wh: string): Promise<SlocOccupancy[]> {
  return (await getSlocOccupancy({ wh, operational: true }))
    .sort((a, b) =>
      a.zone.localeCompare(b.zone) || a.rack_zone.localeCompare(b.rack_zone) ||
      a.aisle.localeCompare(b.aisle) || a.bay.localeCompare(b.bay) ||
      a.level.localeCompare(b.level) || a.bin.localeCompare(b.bin));
}

/**
 * Small first-paint preview for the heatmap. It deliberately samples a bounded
 * number of active SLOCs per operational zone; the full zone remains available
 * through getHeatmapPage when a user needs to inspect it.
 *
 * Hasilnya melewati read model persisten seperti ringkasan zona. Sebelumnya
 * pratinjau hanya tersimpan di memori proses, sehingga pembukaan heatmap pertama
 * setelah setiap deploy — persis saat orang paling ingin melihatnya — kembali
 * menunggu pemindaian penuh, sementara bagian lain halaman sudah menyajikan
 * hasil valid terakhir. Data yang ditampilkan tidak berubah sedikit pun.
 */
export async function getHeatmapPreviews(
  wh: string,
  perZone = 36,
): Promise<Record<string, SlocOccupancy[]>> {
  const scope = cleanScope({ wh, operational: true });
  if (!scope.wh) return {};
  const safePerZone = Number.isFinite(perZone)
    ? Math.min(72, Math.max(12, Math.floor(perZone)))
    : 36;
  return readModelCached(
    `heatmap-preview-v1-${scope.wh}-${safePerZone}`,
    readModelVersion(),
    () => loadHeatmapPreviews(scope.wh!, safePerZone),
    { freshMs: DASHBOARD_TTL },
  );
}

async function loadHeatmapPreviews(
  wh: string,
  safePerZone: number,
): Promise<Record<string, SlocOccupancy[]>> {
  refreshCachesForHistoryChange();
  const scope = { wh } as const;
  const cacheKey = `${scope.wh}|${safePerZone}`;
  const cached = heatPreviewCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DASHBOARD_TTL) return cached.data;

  const previewRows = await queryHistory<SlocMeta & {
    rn: number; l1: string; qty: number; cbm: number; pc: number;
  }>(
    `${WH_MAP()}, ranked AS (
       SELECT v.sloc_id, v.sloc_code, m.wh, v.zone, v.rack_zone, v.aisle, v.bay, v.level, v.bin,
              v.storage_handling AS storage, v.max_quantity, v.max_volume, v.location_id,
              row_number() OVER (
                PARTITION BY v.zone, v.rack_zone
                ORDER BY v.rack_zone, v.aisle, v.bay, v.level, v.bin, v.sloc_code
              )::INT AS rn
       FROM vw_sloc v ${JOIN_WH}
       WHERE ${OPERATIONAL_SLOC} AND ${zoneEnabledSQL()} AND m.wh = ?
     ), sampled AS (
       SELECT * FROM ranked WHERE rn <= ?
     ), stock_agg AS (
       SELECT p.location_id, p.sloc_code, coalesce(s.l1_category,'') AS l1,
              coalesce(sum(s.stock_qty), 0)::DOUBLE AS qty,
              coalesce(sum(s.occupied_cbm), 0)::DOUBLE AS cbm,
              count(DISTINCT s.product_id)::INT AS pc
       FROM sampled p
       LEFT JOIN vw_stock_latest s
         ON s.location_id = p.location_id AND s.sloc_code = p.sloc_code
        AND ${statusPredicateSQL("s.status")}
       GROUP BY 1,2,3
     )
     SELECT p.sloc_id, p.sloc_code, p.wh, p.zone, p.rack_zone, p.aisle, p.bay, p.level, p.bin,
            p.storage, p.max_quantity, p.max_volume, p.location_id, p.rn,
            a.l1, a.qty, a.cbm, a.pc
     FROM sampled p
     LEFT JOIN stock_agg a ON a.location_id = p.location_id AND a.sloc_code = p.sloc_code
     ORDER BY p.zone, p.rack_zone, p.aisle, p.bay, p.level, p.bin, p.sloc_code`,
    [scope.wh, safePerZone],
  );
  if (!previewRows.length) {
    const empty: Record<string, SlocOccupancy[]> = {};
    setBoundedCache(heatPreviewCache, cacheKey, { at: Date.now(), data: empty }, 10);
    return empty;
  }

  const rowKey = (locationId: number, slocCode: string) => `${locationId}|${slocCode}`;
  const metaByKey = new Map<string, SlocMeta>();
  const byKey = new Map<string, { qty: number; cbm: number; pc: number }>();
  for (const row of previewRows) {
    const key = rowKey(row.location_id, row.sloc_code);
    if (!metaByKey.has(key)) metaByKey.set(key, row);
    const m = metaByKey.get(key);
    if (!m || !categoryCounted(row.l1, capacityScope(m))) continue;
    const cur = byKey.get(key) ?? { qty: 0, cbm: 0, pc: 0 };
    cur.qty += row.qty; cur.cbm += row.cbm; cur.pc += row.pc;
    byKey.set(key, cur);
  }

  const data: Record<string, SlocOccupancy[]> = {};
  for (const m of metaByKey.values()) {
    const eff = resolveSloc(capacityScope(m));
    const o = byKey.get(rowKey(m.location_id, m.sloc_code)) ?? { qty: 0, cbm: 0, pc: 0 };
    const pq = eff.qty_valid && eff.cap_qty > 0 ? (o.qty / eff.cap_qty) * 100 : null;
    const pv = eff.cbm_valid && eff.cap_cbm > 0 ? (o.cbm / eff.cap_cbm) * 100 : null;
    const pct = (eff.basis === "qty" ? pq : pv) ?? (eff.basis === "qty" ? pv : pq) ?? 0;
    const occupied = o.qty > 0 || o.cbm > 0;
    const cell = {
      sloc_id: m.sloc_id, sloc_code: m.sloc_code, wh: m.wh, zone: m.zone, rack_zone: m.rack_zone,
      aisle: m.aisle, bay: m.bay, level: m.level, bin: m.bin, storage: m.storage,
      basis: eff.basis,
      occ_qty: r1(o.qty), cap_qty: r1(eff.cap_qty), occ_cbm: r3(o.cbm), cap_cbm: r3(eff.cap_cbm),
      cap_cbm_nominal: r4(eff.cap_cbm_nominal), utilization_pct: eff.utilization_pct,
      qty_valid: eff.qty_valid, cbm_valid: eff.cbm_valid,
      pct_qty: pq === null ? null : r1(pq), pct_cbm: pv === null ? null : r1(pv),
      occupied, pct_bin: occupied ? 100 : 0, pct: r1(pct),
      ...occupancyStatuses({ pct_qty: pq, pct_cbm: pv }, pct, m.wh), status_bin: "NORMAL",
      product_count: o.pc,
    } satisfies SlocOccupancy;
    (data[`${m.zone}|${m.rack_zone}`] ??= []).push(cell);
  }
  setBoundedCache(heatPreviewCache, cacheKey, { at: Date.now(), data }, 10);
  return data;
}

/**
 * Browser-safe heatmap payload. A warehouse such as CBT can have nearly
 * 100k active racks; returning every cell turns a useful heatmap into a very
 * large JSON response and DOM tree. The UI loads a compact zone index first,
 * then pages the selected zone.
 */
export async function getHeatmapPage(
  wh: string,
  zone: string,
  rackZone = "",
  offset = 0,
  limit = 600
): Promise<{ cells: SlocOccupancy[]; total: number; offset: number; nextOffset: number | null }> {
  // Route input is user-controlled. Keep malformed pagination values from
  // reaching Array.slice(), whose NaN coercion is surprising and can make the
  // response look as if the selected zone has no data.
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const safeLimit = Number.isFinite(limit)
    ? Math.min(1_000, Math.max(100, Math.floor(limit)))
    : 600;
  const scope = cleanScope({ wh, zone, operational: true });
  if (!scope.wh || !scope.zone) return { cells: [], total: 0, offset: safeOffset, nextOffset: null };
  const normalizedRackZone = rackZone.trim().toUpperCase();

  // One bounded query returns the page, its total, and stock aggregates from
  // the same read snapshot. This replaces three connection opens per click.
  const pageRows = await queryHistory<SlocMeta & {
    total: number; l1: string; qty: number; cbm: number; pc: number;
  }>(
    `${WH_MAP()}, scoped AS (
       SELECT v.sloc_id, v.sloc_code, m.wh, v.zone, v.rack_zone, v.aisle, v.bay, v.level, v.bin,
              v.storage_handling AS storage, v.max_quantity, v.max_volume, v.location_id
       FROM vw_sloc v ${JOIN_WH}
       WHERE ${OPERATIONAL_SLOC} AND ${zoneEnabledSQL()} AND m.wh = ? AND v.zone = ?
         ${normalizedRackZone ? "AND v.rack_zone = ?" : ""}
     ), paged AS (
       SELECT *, count(*) OVER ()::INT AS total
       FROM scoped
       ORDER BY rack_zone, aisle, bay, level, bin, sloc_code
       LIMIT ? OFFSET ?
     ), stock_agg AS (
       SELECT p.location_id, p.sloc_code, coalesce(s.l1_category, '') AS l1,
              coalesce(sum(s.stock_qty), 0)::DOUBLE AS qty,
              coalesce(sum(s.occupied_cbm), 0)::DOUBLE AS cbm,
              count(DISTINCT s.product_id)::INT AS pc
       FROM paged p
       LEFT JOIN vw_stock_latest s
         ON s.location_id = p.location_id AND s.sloc_code = p.sloc_code
        AND ${statusPredicateSQL("s.status")}
       GROUP BY 1, 2, 3
     )
     SELECT p.sloc_id, p.sloc_code, p.wh, p.zone, p.rack_zone, p.aisle, p.bay, p.level, p.bin,
            p.storage, p.max_quantity, p.max_volume, p.location_id, p.total,
            a.l1, a.qty, a.cbm, a.pc
     FROM paged p
     LEFT JOIN stock_agg a
       ON a.location_id = p.location_id AND a.sloc_code = p.sloc_code
     ORDER BY p.rack_zone, p.aisle, p.bay, p.level, p.bin, p.sloc_code`,
    [scope.wh, scope.zone, ...(normalizedRackZone ? [normalizedRackZone] : []), safeLimit, safeOffset],
  );
  if (!pageRows.length) return { cells: [], total: 0, offset: safeOffset, nextOffset: null };

  const keyFor = (locationId: number, slocCode: string) => `${locationId}|${slocCode}`;
  const metaByCode = new Map<string, SlocMeta>();
  const byCode = new Map<string, { qty: number; cbm: number; pc: number }>();
  for (const row of pageRows) {
    const key = keyFor(row.location_id, row.sloc_code);
    if (!metaByCode.has(key)) metaByCode.set(key, row);
    const meta = metaByCode.get(key);
    if (!meta || !categoryCounted(row.l1, capacityScope(meta))) continue;
    const current = byCode.get(key) ?? { qty: 0, cbm: 0, pc: 0 };
    current.qty += row.qty; current.cbm += row.cbm; current.pc += row.pc;
    byCode.set(key, current);
  }
  const cells = [...metaByCode.values()].map((m) => {
    const eff = resolveSloc(capacityScope(m));
    const o = byCode.get(keyFor(m.location_id, m.sloc_code)) ?? { qty: 0, cbm: 0, pc: 0 };
    const pq = eff.qty_valid && eff.cap_qty > 0 ? (o.qty / eff.cap_qty) * 100 : null;
    const pv = eff.cbm_valid && eff.cap_cbm > 0 ? (o.cbm / eff.cap_cbm) * 100 : null;
    const pct = (eff.basis === "qty" ? pq : pv) ?? (eff.basis === "qty" ? pv : pq) ?? 0;
    const occupied = o.qty > 0 || o.cbm > 0;
    return {
      sloc_id: m.sloc_id, sloc_code: m.sloc_code, wh: m.wh, zone: m.zone, rack_zone: m.rack_zone,
      aisle: m.aisle, bay: m.bay, level: m.level, bin: m.bin, storage: m.storage, basis: eff.basis,
      occ_qty: r1(o.qty), cap_qty: r1(eff.cap_qty), occ_cbm: r3(o.cbm), cap_cbm: r3(eff.cap_cbm),
      cap_cbm_nominal: r4(eff.cap_cbm_nominal), utilization_pct: eff.utilization_pct,
      qty_valid: eff.qty_valid, cbm_valid: eff.cbm_valid,
      pct_qty: pq === null ? null : r1(pq), pct_cbm: pv === null ? null : r1(pv),
      occupied, pct_bin: occupied ? 100 : 0, pct: r1(pct),
      ...occupancyStatuses({ pct_qty: pq, pct_cbm: pv }, pct, m.wh), status_bin: "NORMAL",
      product_count: o.pc,
    } satisfies SlocOccupancy;
  });
  const total = pageRows[0]?.total ?? 0;
  const nextOffset = safeOffset + cells.length < total ? safeOffset + cells.length : null;
  return { cells, total, offset: safeOffset, nextOffset };
}

/** Isi zona: baris SKU per SLOC + okupansi SLOC-nya. */
export interface ZoneLine {
  sloc_code: string; rack_zone: string; storage: string;
  sku_number: string; product_name: string; l1_category: string; status: string;
  qty: number; cbm: number;
  sloc_pct: number; sloc_basis: Basis; sloc_status: string;
}
export interface ZoneDetailResult {
  rows: ZoneLine[];
  total: number;
  truncated: boolean;
}
export type ZoneDetailSort =
  | "sloc_code" | "sku_number" | "product_name" | "qty" | "cbm" | "sloc_pct";
export interface ZoneDetailOptions {
  offset?: number;
  limit?: number;
  query?: string;
  sort?: ZoneDetailSort;
  direction?: "asc" | "desc";
  /** Status stok Superset (Available, Quality inspection, …). */
  status?: string;
  /** Kategori L1 produk. */
  category?: string;
  /** Sub-zona rak, mis. SRA1. */
  rackZone?: string;
  /**
   * Ekspor: ambil seluruh baris yang cocok, bukan satu halaman. Batas keras
   * tetap dipasang agar satu zona yang tak wajar besar tidak menghabiskan
   * memori proses.
   */
  all?: boolean;
}

/** Batas keras baris isi zona untuk satu berkas ekspor. */
export const ZONE_DETAIL_EXPORT_MAX_ROWS = 200_000;

export async function getZoneDetail(
  wh: string,
  zone: string,
  options: ZoneDetailOptions = {},
): Promise<ZoneDetailResult> {
  const scope = cleanScope({ wh, zone, operational: true });
  if (!scope.wh || !scope.zone) return { rows: [], total: 0, truncated: false };
  const safeOffset = options.all
    ? 0
    : Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset ?? 0)) : 0;
  const safeLimit = options.all
    ? ZONE_DETAIL_EXPORT_MAX_ROWS
    : Number.isFinite(options.limit)
      ? Math.min(200, Math.max(25, Math.floor(options.limit ?? 100)))
      : 100;
  const query = (options.query ?? "").trim().toLocaleLowerCase().slice(0, 120);
  const statusFilter = (options.status ?? "").trim().slice(0, 60);
  const categoryFilter = (options.category ?? "").trim().slice(0, 80);
  const rackZoneFilter = (options.rackZone ?? "").trim().toUpperCase().slice(0, 40);
  const sortColumns: Record<ZoneDetailSort, string> = {
    sloc_code: "sloc_code",
    sku_number: "sku_number",
    product_name: "product_name",
    qty: "qty",
    cbm: "cbm",
    sloc_pct: "sloc_pct",
  };
  const sort = sortColumns[options.sort ?? "sloc_code"];
  const direction = options.direction === "desc" ? "DESC" : "ASC";
  const cap = capacitySqlExpressions();
  const rows = await queryHistory<{
    total: number; wh: string; sloc_code: string; rack_zone: string; storage: string;
    sku_number: string; product_name: string; l1_category: string; status: string;
    qty: number; cbm: number; sloc_pct: number; sloc_basis: Basis;
    pct_qty: number | null; pct_cbm: number | null;
  }>(
    `${WH_MAP()}, effective AS MATERIALIZED (
       SELECT v.sloc_id, v.location_id, v.sloc_code, m.wh, v.zone,
              coalesce(v.rack_zone, '') AS rack_zone, coalesce(v.aisle, '') AS aisle,
              coalesce(v.bay, '') AS bay, coalesce(v.level, '') AS level,
              coalesce(v.bin, '') AS bin, coalesce(v.storage_handling, '') AS storage,
              coalesce(v.storage_handling, '') AS storage_handling,
              ${cap.basis} AS basis, ${cap.capQty} AS cap_qty, ${cap.capCbm} AS cap_cbm,
              ${cap.qtyValid} AS qty_valid, ${cap.cbmValid} AS cbm_valid
       FROM vw_sloc v ${JOIN_WH}
       WHERE ${OPERATIONAL_SLOC} AND ${zoneEnabledSQL()} AND m.wh = ? AND v.zone = ?
     ), occupied AS (
       SELECT e.location_id, e.sloc_code,
              coalesce(sum(CASE
                WHEN ${statusPredicateSQL("s.status")}
                 AND ${categoryPredicateSQL("s.l1_category", "e", "e")}
                THEN s.stock_qty ELSE 0 END), 0)::DOUBLE AS occ_qty,
              coalesce(sum(CASE
                WHEN ${statusPredicateSQL("s.status")}
                 AND ${categoryPredicateSQL("s.l1_category", "e", "e")}
                THEN s.occupied_cbm ELSE 0 END), 0)::DOUBLE AS occ_cbm
       FROM effective e
       LEFT JOIN vw_stock_latest s
         ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
       GROUP BY e.location_id, e.sloc_code
     ), ratios AS (
       SELECT e.*, o.occ_qty, o.occ_cbm,
              CASE WHEN e.qty_valid AND e.cap_qty > 0
                THEN 100.0 * o.occ_qty / e.cap_qty ELSE NULL END AS pct_qty,
              CASE WHEN e.cbm_valid AND e.cap_cbm > 0
                THEN 100.0 * o.occ_cbm / e.cap_cbm ELSE NULL END AS pct_cbm
       FROM effective e
       JOIN occupied o
         ON o.location_id = e.location_id AND o.sloc_code = e.sloc_code
     ), scored AS (
       SELECT *,
              CASE WHEN basis = 'qty'
                THEN coalesce(pct_qty, pct_cbm, 0)
                ELSE coalesce(pct_cbm, pct_qty, 0)
              END AS sloc_pct
       FROM ratios
     ), stock_rows AS (
       SELECT e.wh, e.location_id, e.sloc_code, e.rack_zone, e.storage,
              e.pct_qty, e.pct_cbm,
              s.sku_number, s.product_name, coalesce(s.l1_category, '') AS l1_category,
              s.status, s.stock_qty::DOUBLE AS qty, s.occupied_cbm::DOUBLE AS cbm,
              e.sloc_pct, e.basis AS sloc_basis
       FROM scored e
       JOIN vw_stock_latest s
         ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
     ), filtered AS (
       SELECT *
       FROM stock_rows
       WHERE (? = '' OR lower(
         coalesce(sloc_code, '') || ' ' || coalesce(sku_number, '') || ' ' ||
         coalesce(product_name, '') || ' ' || coalesce(l1_category, '')
       ) LIKE ?)
         AND (? = '' OR coalesce(status, '') = ?)
         AND (? = '' OR coalesce(l1_category, '') = ?)
         AND (? = '' OR upper(coalesce(rack_zone, '')) = ?)
     ), details AS (
       SELECT *, count(*) OVER ()::INT AS total
       FROM filtered
       ORDER BY ${sort} ${direction}, sloc_code ASC, sku_number ASC
       LIMIT ? OFFSET ?
     )
     SELECT total, wh, sloc_code, rack_zone, storage, sku_number, product_name,
            l1_category, status, qty, cbm, sloc_pct, sloc_basis, pct_qty, pct_cbm
     FROM details
     ORDER BY ${sort} ${direction}, sloc_code ASC, sku_number ASC`,
    [
      scope.wh, scope.zone, query, `%${query}%`,
      statusFilter, statusFilter, categoryFilter, categoryFilter,
      rackZoneFilter, rackZoneFilter,
      safeLimit, safeOffset,
    ],
  );
  const mapped = rows.map((r) => {
    return {
      sloc_code: r.sloc_code, rack_zone: r.rack_zone, storage: r.storage,
      sku_number: r.sku_number, product_name: r.product_name, l1_category: r.l1_category,
      status: r.status,
      qty: r1(r.qty), cbm: r3(r.cbm),
      sloc_pct: r1(r.sloc_pct), sloc_basis: r.sloc_basis,
      // Lencana lokasi di sini harus identik dengan lencana lokasi yang sama di
      // heatmap, jadi ia memakai bacaan dua basis — bukan satu angka kebijakan.
      sloc_status: statusForRow(
        { pct_qty: r.pct_qty, pct_cbm: r.pct_cbm }, r.sloc_pct, r.wh,
      ),
    } satisfies ZoneLine;
  });
  const total = rows[0]?.total ?? 0;
  return {
    rows: mapped,
    total,
    truncated: safeOffset > 0 || safeOffset + mapped.length < total,
  };
}

export interface ZoneDetailFacets {
  statuses: string[];
  categories: string[];
  rack_zones: string[];
}

/**
 * Pilihan filter isi zona diambil dari zona itu sendiri. Daftar status stok dan
 * kategori L1 berbeda antar gudang, jadi menuliskannya sebagai konstanta akan
 * menawarkan filter yang tidak pernah menghasilkan satu baris pun.
 */
export async function getZoneDetailFacets(wh: string, zone: string): Promise<ZoneDetailFacets> {
  const scope = cleanScope({ wh, zone, operational: true });
  if (!scope.wh || !scope.zone) return { statuses: [], categories: [], rack_zones: [] };
  const rows = await queryHistory<{ status: string; category: string; rack_zone: string }>(
    `${WH_MAP()}, scoped AS (
       SELECT v.location_id, v.sloc_code, coalesce(v.rack_zone, '') AS rack_zone
       FROM vw_sloc v ${JOIN_WH}
       WHERE ${OPERATIONAL_SLOC} AND ${zoneEnabledSQL()} AND m.wh = ? AND v.zone = ?
     )
     SELECT DISTINCT coalesce(s.status, '') AS status,
            coalesce(s.l1_category, '') AS category,
            e.rack_zone
     FROM scoped e
     LEFT JOIN vw_stock_latest s
       ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code`,
    [scope.wh, scope.zone],
  );
  const statuses = new Set<string>();
  const categories = new Set<string>();
  const rackZones = new Set<string>();
  for (const row of rows) {
    if (row.status) statuses.add(row.status);
    if (row.category) categories.add(row.category);
    if (row.rack_zone) rackZones.add(row.rack_zone);
  }
  return {
    statuses: [...statuses].sort(naturalOrder.compare),
    categories: [...categories].sort(naturalOrder.compare),
    rack_zones: [...rackZones].sort(naturalOrder.compare),
  };
}

/**
 * Deret aliran stok per jam, dari PERGERAKAN — bukan dari snapshot stok.
 *
 * KENAPA BUKAN DARI stock_history
 * -------------------------------
 * Job `stock_snapshot` berjalan dengan mode "snapshot": setiap pass mengganti
 * isi tabelnya, sehingga `stock_history` hanya pernah memuat SATU snapshot.
 * Diperiksa pada basis data ini: 90.573 baris, seluruhnya dengan `_synced_at`
 * yang sama. Akibatnya seluruh proyeksi mati diam-diam — `wmaRatePctPerHour()`
 * menuntut minimal tiga titik, `lag()` pada satu snapshot hanya menghasilkan
 * NULL, dan halaman Proyeksi menampilkan "menunggu riwayat" untuk kedelapan
 * gudang tanpa pernah menjelaskan bahwa riwayatnya memang tidak akan pernah
 * datang.
 *
 * Pergerakan menyimpan yang justru dibutuhkan: 356 ribu kejadian bertanda waktu
 * dengan arah (+/-) dan jumlahnya, retensi 14 hari. Dari sana laju masuk dan
 * keluar per jam dapat dihitung langsung, dan lintasan okupansi disusun ulang
 * mundur dari keadaan sekarang. Angka yang dihasilkan juga konsisten dengan
 * halaman Pergerakan, karena keduanya membaca kolom `direction` yang sama.
 */
export interface MovementFlowBucket {
  wh: string;
  /** Awal jamnya, ISO ber-offset WIB. */
  t: string;
  qty_in: number;
  qty_out: number;
  events: number;
}

/**
 * Jendelanya diikat ke PERGERAKAN TERBARU, bukan ke jam dinding sekarang.
 *
 * Kalau sinkronisasi tertinggal — dan itu terjadi: pada mesin ini data terakhir
 * berumur dua hari — jendela yang diikat ke `now()` menghasilkan nol baris, dan
 * seluruh halaman Proyeksi kembali kosong persis seperti sebelum diperbaiki.
 * Yang benar-benar ingin dijawab halaman itu adalah "bagaimana laju gudang ini
 * pada 48 jam terakhir yang DIKETAHUI", dan jawaban itu tetap ada meski
 * sinkronnya terlambat.
 *
 * Konsekuensinya harus terlihat, bukan disembunyikan: titik terakhir lintasan
 * membawa stempel waktunya sendiri, dan halaman Proyeksi menampilkannya supaya
 * proyeksi dari data lama tidak pernah terbaca sebagai proyeksi dari data baru.
 */
async function loadMovementFlowSeries(hoursBack: number): Promise<MovementFlowBucket[]> {
  const window = Math.max(1, Math.floor(hoursBack));
  return movementQuery<MovementFlowBucket>(
    `${movementSource()}, span AS (SELECT max(created_at) AS latest FROM mv)
     SELECT mv.wh,
            ${sourceIso("date_trunc('hour', mv.created_at)")} AS t,
            coalesce(sum(CASE WHEN mv.direction = 'OUT' THEN 0 ELSE mv.qty END), 0)::DOUBLE AS qty_in,
            coalesce(sum(CASE WHEN mv.direction = 'OUT' THEN mv.qty ELSE 0 END), 0)::DOUBLE AS qty_out,
            count(*)::INT AS events
     FROM mv, span
     WHERE mv.created_at >= span.latest - INTERVAL ${window} HOUR
     GROUP BY mv.wh, date_trunc('hour', mv.created_at)
     ORDER BY mv.wh, date_trunc('hour', mv.created_at)`,
  );
}

/** Jendela yang dipakai proyeksi. Sama untuk laju, lintasan, dan simulator. */
export const FORECAST_WINDOW_HOURS = 48;

/**
 * Berapa banyak jam terakhir yang menentukan laju.
 *
 * Gudang punya irama harian yang kuat — puncaknya 09:00–13:00 pada basis data
 * ini. Merata-ratakan seluruh 48 jam meredam irama itu sampai proyeksinya tidak
 * lagi menggambarkan shift yang sedang berjalan, sementara memakai satu jam
 * terakhir membuatnya melompat-lompat mengikuti satu truk yang kebetulan
 * datang. Enam jam adalah kompromi yang mengikuti shift tanpa mengikuti
 * kebisingannya.
 */
const RATE_LOOKBACK_HOURS = 6;

async function loadForecastRows(): Promise<ForecastRow[]> {
  // Lintasan dan lajunya berasal dari read model yang sama dengan grafik tren di
  // Ringkasan. Menghitungnya dua kali adalah cara paling pasti membuat halaman
  // Proyeksi dan halaman Ringkasan menyebut angka berbeda untuk gudang yang sama.
  const [base, projections] = await Promise.all([
    getWarehouseOccupancySummary(),
    getWarehouseProjections(),
  ]);

  return base.map((warehouse) => {
    const projection = projections.get(warehouse.code);
    const capBasis = warehouse.basis === "qty" ? warehouse.cap_qty : warehouse.cap_cbm;
    const ready = Boolean(projection?.ready);
    const cbmPerUnit = warehouse.occ_qty > 0 ? warehouse.occ_cbm / warehouse.occ_qty : 0;
    const toBasis = (qty: number) => (warehouse.basis === "qty" ? qty : qty * cbmPerUnit);
    const rate = ready ? projection!.rate_pct_per_hour : 0;
    const asFlow = (qty: number) =>
      warehouse.basis === "qty" ? r1(qty) : r3(toBasis(qty));

    return {
      warehouse: warehouse.code,
      name: warehouse.name,
      basis: warehouse.basis,
      current_pct: warehouse.pct,
      rate_pct_per_hour: ready ? r3(rate) : 0,
      qty_now: warehouse.occ_qty,
      net_rate: ready ? asFlow(projection!.net_per_hour) : 0,
      bins_now: warehouse.sloc_occupied,
      sloc_total: warehouse.sloc_total,
      cap_basis: capBasis,
      in_rate: ready ? asFlow(projection!.in_per_hour) : 0,
      out_rate: ready ? asFlow(projection!.out_per_hour) : 0,
      flow_unit: warehouse.basis === "qty" ? "unit" : "m³",
      hours_to_95: ready ? hoursToTarget(warehouse.pct, rate, 95) : null,
      hours_to_100: ready ? hoursToTarget(warehouse.pct, rate, 100) : null,
      history_points: projection?.buckets ?? 0,
      history_span_hours: r1(projection?.span_hours ?? 0),
      forecast_ready: ready,
      trend: (projection?.trail ?? []).map((point) => ({ t: point.t, pct: point.pct })),
    } satisfies ForecastRow;
  });
}

export async function getForecastRows(): Promise<ForecastRow[]> {
  return readModelCached(
    "forecast-rows-v2-movement",
    readModelVersion(),
    loadForecastRows,
    { freshMs: DASHBOARD_TTL },
  );
}

export async function getSlocDetail(
  code: string, wh?: string,
): Promise<{ stock: StockLine[]; movements: MovementRow[] }> {
  const scope = cleanScope({ wh, operational: true });
  if (wh && !scope.wh) return { stock: [], movements: [] };
  const [stock, movements] = await Promise.all([
    queryHistory<StockLine>(
      `${WH_MAP()}, valid AS (
         SELECT v.location_id, v.sloc_code FROM vw_sloc v ${JOIN_WH}
         WHERE ${OPERATIONAL_SLOC}${scope.wh ? " AND m.wh = ?" : ""}
       )
       SELECT product_id, product_name, sku_number, coalesce(l1_category,'') AS l1_category,
               status, stock_qty AS qty, occupied_cbm AS cbm
        FROM vw_stock_latest s
        JOIN valid v ON v.location_id = s.location_id AND v.sloc_code = s.sloc_code
        WHERE s.sloc_code = ?
        ORDER BY occupied_cbm DESC LIMIT 50`,
      scope.wh ? [scope.wh, code] : [code],
    ),
    // Pergerakan dibaca lewat read-model bersama: satu-satunya cara agar panel
    // SLOC, tabel gudang, dan halaman Movement menampilkan kejadian yang sama
    // dengan tipe aksi yang sama.
    getRecentMovements(code, 12, scope.wh).catch(() => []),
  ]);
  return { stock, movements };
}

export async function getSyncHealth() {
  // Keduanya berjam WIB. Tanpa offset eksplisit, halaman yang dirender di
  // kontainer UTC melaporkan snapshot tujuh jam lebih lambat daripada
  // kenyataannya — dan pemeriksaan umur di /api/health ikut salah sebanyak itu.
  const snap = await queryHistory<{ last: string | null; rows: number }>(
    `SELECT ${wibIso("max(_synced_at)")} AS last, count(*)::BIGINT AS rows FROM stock_history`
  );
  const audit = await queryHistory(
    `SELECT job, mode, ${wibIso("finished_at")} AS finished_at, rows_written, status
     FROM _sync_audit ORDER BY finished_at DESC LIMIT 8`
  ).catch(() => []);
  return { last_snapshot: snap[0]?.last ?? null, snapshot_rows: snap[0]?.rows ?? 0, recent_syncs: audit };
}

// ---------------------------------------------------------------------------
// Recent movements (dataset Superset 705 → movement_events → vw_movement)
// ---------------------------------------------------------------------------
//
// SCOPE GUDANG — sama seperti seluruh read-model lain, `wh_map` adalah
// allowlist-nya. Bedanya, pergerakan membawa `location_id` sendiri, sehingga
// gudangnya tidak perlu ditebak dari kode rak. Itu penting: sebuah pergerakan
// bisa berakhir di rak yang belum ada pada master SLOC (rak baru, atau
// `to_rack_name` kosong pada pengeluaran barang), dan versi lama diam-diam
// membuang baris seperti itu karena mensyaratkan kode raknya cocok.
//
// STANDARDISASI AKSI — `inventory_action` ditulis bebas oleh WMS. Tipe kanonik
// dihitung di SQL dari tabel aturan yang sama dengan yang dipakai antarmuka
// (lib/movements.ts), jadi filter di server dan label di layar tidak mungkin
// memakai taksonomi yang berbeda.

/** Sumber pergerakan yang sudah ber-scope, terstandardisasi, dan bertanda. */
function movementSource(): string {
  return `${WH_MAP()}, mv AS (
    SELECT
      v.movement_uid,
      v.created_at,
      v.updated_at,
      m.wh,
      coalesce(v.location_name, '') AS location_name,
      coalesce(v.invoice_number, '') AS invoice_number,
      v.product_id,
      coalesce(v.product_name, '') AS product_name,
      coalesce(v.sku_number, '') AS sku_number,
      coalesce(v.l1_category, '') AS l1_category,
      coalesce(v.product_type, '') AS product_type,
      nullif(trim(coalesce(v.source_sloc, '')), '') AS source_sloc,
      nullif(trim(coalesce(v.destination_sloc, '')), '') AS destination_sloc,
      coalesce(v.action_raw, '') AS action_raw,
      ${movementTypeSQL("v.action_raw")} AS movement_type,
      ${movementDirectionSQL("v.operator_sign")} AS direction,
      ${movementFlowSQL("v.source_sloc", "v.destination_sloc")} AS flow,
      nullif(trim(coalesce(v.from_package, '')), '') AS from_package,
      nullif(trim(coalesce(v.to_package, '')), '') AS to_package,
      nullif(trim(coalesce(v.from_status, '')), '') AS from_status,
      nullif(trim(coalesce(v.to_status, '')), '') AS to_status,
      coalesce(v.operator, '') AS operator,
      abs(coalesce(v.qty, 0))::DOUBLE AS qty
    FROM vw_movement v
    JOIN wh_map m ON m.location_id = v.location_id
  )`;
}

/**
 * Agregat pergerakan yang TIDAK bergantung pada paginasi maupun pengurutan.
 *
 * Ringkasan, grafik aktivitas, dan strip per gudang semuanya dihitung dari
 * klausa WHERE yang sama — `movementWhere()` tidak pernah membaca `sort`,
 * `dir`, `offset`, atau `limit`. Namun halaman Pergerakan menembakkan
 * keempatnya lagi pada SETIAP klik, termasuk klik yang hanya memindahkan
 * halaman atau membalik urutan kolom, dan antrean riwayat menjalankannya
 * berurutan. Terukur pada basis data ini: satu klik "halaman berikutnya"
 * membayar tiga pemindaian penuh untuk mendapatkan angka yang sudah ada di
 * layar dan tidak berubah sedikit pun.
 *
 * Kuncinya sengaja hanya memuat medan yang benar-benar masuk ke WHERE, plus
 * sidik jari read model, sehingga snapshot baru atau perubahan kebijakan
 * membatalkannya sendiri. Isinya kecil (angka, bukan baris), jadi batas entri
 * yang rendah sudah cukup untuk menampung perpindahan bolak-balik antar filter
 * yang lazim dalam satu sesi.
 */
const movementAggregateCache = new Map<string, { at: number; value: unknown }>();

function movementFilterKey(filter: MovementFilter): string {
  return JSON.stringify([
    filter.range, filter.wh, [...filter.type].sort(), filter.direction, filter.flow,
    filter.category, filter.productType, filter.status, filter.operator,
    filter.sloc, filter.q,
  ]);
}

async function cachedMovementAggregate<T>(
  name: string,
  filter: MovementFilter,
  load: () => Promise<T>,
): Promise<T> {
  refreshCachesForHistoryChange();
  const key = `${name}|${readModelVersion()}|${movementFilterKey(filter)}`;
  const cached = movementAggregateCache.get(key);
  if (cached && Date.now() - cached.at < DASHBOARD_TTL) return cached.value as T;
  const value = await load();
  setBoundedCache(movementAggregateCache, key, { at: Date.now(), value }, 48);
  return value;
}

/** Klausa WHERE + parameter dari kontrak filter bersama. */
function movementWhere(filter: MovementFilter): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const hours = RANGE_HOURS[filter.range];
  if (hours !== null) {
    clauses.push("mv.created_at >= ?");
    // Kolomnya berjam sumber (tujuh jam di depan WIB), jadi ambangnya juga.
    params.push(sourceCutoff(hours));
  }
  if (filter.wh) { clauses.push("mv.wh = ?"); params.push(filter.wh); }
  if (filter.type.length) {
    // Nilai berasal dari daftar tertutup MOVEMENT_TYPES; tetap diikat sebagai
    // parameter supaya tidak ada jalur apa pun dari masukan ke teks SQL.
    clauses.push(`mv.movement_type IN (${filter.type.map(() => "?").join(", ")})`);
    params.push(...filter.type);
  }
  if (filter.direction) { clauses.push("mv.direction = ?"); params.push(filter.direction); }
  if (filter.flow) { clauses.push("mv.flow = ?"); params.push(filter.flow); }
  if (filter.category) { clauses.push("mv.l1_category = ?"); params.push(filter.category); }
  if (filter.productType) { clauses.push("mv.product_type = ?"); params.push(filter.productType); }
  if (filter.status) { clauses.push("mv.to_status = ?"); params.push(filter.status); }
  if (filter.operator) { clauses.push("mv.operator = ?"); params.push(filter.operator); }
  if (filter.sloc) {
    clauses.push("(mv.source_sloc ILIKE ? OR mv.destination_sloc ILIKE ?)");
    params.push(`%${filter.sloc}%`, `%${filter.sloc}%`);
  }
  if (filter.q) {
    const like = `%${filter.q}%`;
    clauses.push(`(mv.product_name ILIKE ? OR mv.sku_number ILIKE ? OR mv.invoice_number ILIKE ?
       OR mv.source_sloc ILIKE ? OR mv.destination_sloc ILIKE ?
       OR mv.from_package ILIKE ? OR mv.to_package ILIKE ?
       OR mv.operator ILIKE ? OR mv.action_raw ILIKE ?)`);
    params.push(like, like, like, like, like, like, like, like, like);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

const MOVEMENT_SORT_SQL: Record<MovementSort, string> = {
  at: "mv.created_at",
  qty: "mv.qty",
  product: "mv.product_name",
  type: "mv.movement_type",
  wh: "mv.wh",
  operator: "mv.operator",
  invoice: "mv.invoice_number",
};

/** Batas keras satu halaman tabel; ekspor memakai batasnya sendiri. */
export const MOVEMENT_PAGE_MAX = 500;
export const MOVEMENT_EXPORT_MAX_ROWS = 100_000;

/**
 * Pergerakan belum tentu sudah pernah disinkronkan — pada instalasi baru
 * tabelnya memang belum ada. Itu keadaan normal, bukan kegagalan, jadi
 * pembacaannya berujung pada keadaan kosong dan bukan pada batas error halaman.
 */
async function movementQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  try {
    return await queryHistory<T>(sql, params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/movement_events|vw_movement/i.test(message)) return [];
    throw error;
  }
}

/** Satu tarikan baris; `limit` sudah dibatasi pemanggil. */
function movementRowsQuery(
  filter: MovementFilter, limit: number, offset: number,
): Promise<MovementRow[]> {
  const where = movementWhere(filter);
  const order = MOVEMENT_SORT_SQL[filter.sort];
  const dir = filter.dir === "asc" ? "ASC" : "DESC";
  return movementQuery<MovementRow>(
    `${movementSource()}
     SELECT movement_uid, ${sourceIso("created_at")} AS at, ${sourceIso("updated_at")} AS updated_at,
            wh, location_name, invoice_number, product_id, product_name, sku_number,
            l1_category, product_type, source_sloc, destination_sloc, action_raw,
            movement_type, direction, flow, from_package, to_package,
            from_status, to_status, operator, qty,
            (CASE WHEN direction = 'OUT' THEN -qty ELSE qty END)::DOUBLE AS qty_signed
     FROM mv ${where.sql}
     ORDER BY ${order} ${dir}, mv.created_at DESC, mv.movement_uid
     LIMIT ${Math.trunc(limit)} OFFSET ${Math.trunc(offset)}`,
    where.params,
  );
}

export async function getMovementRows(
  filter: MovementFilter, offset = 0, limit = 100,
): Promise<MovementRow[]> {
  return movementRowsQuery(
    filter,
    Math.min(MOVEMENT_PAGE_MAX, Math.max(1, Math.trunc(limit))),
    Math.max(0, Math.trunc(offset)),
  );
}

/**
 * Ringkasan + rincian per tipe dalam SATU pemindaian.
 *
 * Sumbernya besar: 356 ribu baris masuk per hari, jadi retensi 14 hari berarti
 * beberapa juta baris per kueri. Dua kueri terpisah — total dan per tipe —
 * berarti memindai tabel itu dua kali untuk satu tampilan layar. GROUPING SETS
 * menghasilkan keduanya sekaligus: baris dengan `grouping()` = 1 adalah
 * totalnya, sisanya per tipe.
 */
export async function getMovementSummary(filter: MovementFilter): Promise<MovementSummary> {
  return cachedMovementAggregate("summary", filter, () => loadMovementSummary(filter));
}

async function loadMovementSummary(filter: MovementFilter): Promise<MovementSummary> {
  const where = movementWhere(filter);
  const rows = await movementQuery<{
    movement_type: MovementType | null; is_total: number;
    events: number; qty_in: number; qty_out: number; sku_count: number;
    operator_count: number; invoice_count: number; sloc_count: number;
    first_at: string | null; last_at: string | null;
  }>(
    `${movementSource()}
     SELECT movement_type,
            grouping(movement_type)::INT AS is_total,
            count(*)::INT AS events,
            coalesce(sum(CASE WHEN direction = 'OUT' THEN 0 ELSE qty END), 0)::DOUBLE AS qty_in,
            coalesce(sum(CASE WHEN direction = 'OUT' THEN qty ELSE 0 END), 0)::DOUBLE AS qty_out,
            count(DISTINCT product_id)::INT AS sku_count,
            count(DISTINCT nullif(operator, ''))::INT AS operator_count,
            count(DISTINCT nullif(invoice_number, ''))::INT AS invoice_count,
            count(DISTINCT coalesce(destination_sloc, source_sloc))::INT AS sloc_count,
            ${sourceIso("min(created_at)")} AS first_at,
            ${sourceIso("max(created_at)")} AS last_at
     FROM mv ${where.sql}
     GROUP BY GROUPING SETS ((), (movement_type))`,
    where.params,
  );
  const total = rows.find((row) => Number(row.is_total) === 1);
  if (!total) return EMPTY_MOVEMENT_SUMMARY;
  const qtyIn = Number(total.qty_in ?? 0);
  const qtyOut = Number(total.qty_out ?? 0);
  return {
    events: Number(total.events ?? 0),
    qty_in: r1(qtyIn),
    qty_out: r1(qtyOut),
    qty_net: r1(qtyIn - qtyOut),
    sku_count: Number(total.sku_count ?? 0),
    operator_count: Number(total.operator_count ?? 0),
    invoice_count: Number(total.invoice_count ?? 0),
    sloc_count: Number(total.sloc_count ?? 0),
    by_type: Object.fromEntries(
      rows.filter((row) => Number(row.is_total) === 0 && row.movement_type)
        .map((row) => [row.movement_type as MovementType, Number(row.events)]),
    ),
    first_at: total.first_at ?? null,
    last_at: total.last_at ?? null,
  };
}

/**
 * Ringkasan per gudang — inti dari permintaan "Recent movements PER WH".
 *
 * Filter gudang sengaja diabaikan di sini supaya barisnya tetap dapat
 * dibandingkan satu sama lain; memilih satu gudang menyorotnya, bukan
 * menyembunyikan tujuh lainnya.
 */
export async function getMovementByWarehouse(
  filter: MovementFilter,
): Promise<MovementWarehouseRow[]> {
  // Filter gudang memang diabaikan oleh kuerinya, jadi kuncinya pun harus
  // mengabaikannya — kalau tidak, delapan kunci berbeda menyimpan hasil yang
  // persis sama dan tidak satu pun dapat saling dipakai.
  return cachedMovementAggregate("by-warehouse", { ...filter, wh: "" },
    () => loadMovementByWarehouse(filter));
}

async function loadMovementByWarehouse(
  filter: MovementFilter,
): Promise<MovementWarehouseRow[]> {
  const where = movementWhere({ ...filter, wh: "" });
  const rows = await movementQuery<Omit<MovementWarehouseRow, "name" | "qty_net">>(
    `${movementSource()}
     SELECT wh,
            count(*)::INT AS events,
            coalesce(sum(CASE WHEN direction = 'OUT' THEN 0 ELSE qty END), 0)::DOUBLE AS qty_in,
            coalesce(sum(CASE WHEN direction = 'OUT' THEN qty ELSE 0 END), 0)::DOUBLE AS qty_out,
            count(DISTINCT product_id)::INT AS sku_count,
            count(DISTINCT nullif(operator, ''))::INT AS operator_count,
            ${sourceIso("max(created_at)")} AS last_at
     FROM mv ${where.sql}
     GROUP BY wh ORDER BY events DESC, wh`,
    where.params,
  );
  const names = whNameByCode();
  return rows.map((row) => ({
    ...row,
    name: names.get(row.wh) ?? row.wh,
    qty_in: r1(Number(row.qty_in ?? 0)),
    qty_out: r1(Number(row.qty_out ?? 0)),
    qty_net: r1(Number(row.qty_in ?? 0) - Number(row.qty_out ?? 0)),
    last_at: row.last_at ?? null,
  }));
}

/**
 * Aktivitas per jam/hari untuk grafik ringkas di atas tabel.
 *
 * Rentang pendek dikelompokkan per jam, rentang panjang per hari: satu batang
 * per jam pada rentang 30 hari menghasilkan 720 batang yang tidak terbaca.
 */
export async function getMovementActivity(filter: MovementFilter): Promise<MovementBucket[]> {
  return cachedMovementAggregate("activity", filter, () => loadMovementActivity(filter));
}

async function loadMovementActivity(filter: MovementFilter): Promise<MovementBucket[]> {
  const where = movementWhere(filter);
  const hours = RANGE_HOURS[filter.range];
  const unit = hours !== null && hours <= 72 ? "hour" : "day";
  return movementQuery<MovementBucket>(
    `${movementSource()}
     SELECT ${sourceIso(`date_trunc('${unit}', created_at)`)} AS t,
            coalesce(sum(CASE WHEN direction = 'OUT' THEN 0 ELSE qty END), 0)::DOUBLE AS qty_in,
            coalesce(sum(CASE WHEN direction = 'OUT' THEN qty ELSE 0 END), 0)::DOUBLE AS qty_out,
            count(*)::INT AS events
     FROM mv ${where.sql}
     GROUP BY 1 ORDER BY 1`,
    where.params,
  );
}

/**
 * Pilihan filter yang benar-benar ada pada data.
 *
 * Termasuk daftar aksi MENTAH beserta tipe kanoniknya: standardisasi tidak
 * boleh menyembunyikan apa pun, dan inilah tempat admin dapat memeriksa apakah
 * sebuah ejaan baru dari WMS sudah terpetakan dengan benar atau masih jatuh ke
 * "Lainnya".
 */
async function loadMovementFacets(): Promise<MovementFacets> {
  const scope = movementWhere({ ...EMPTY_MOVEMENT_FILTER, range: "14d" });
  const [warehouses, categories, productTypes, statuses, operators, actions] = await Promise.all([
    movementQuery<{ wh: string; events: number }>(
      `${movementSource()} SELECT wh, count(*)::INT AS events FROM mv ${scope.sql}
       GROUP BY wh ORDER BY wh`, scope.params),
    movementQuery<{ value: string }>(
      `${movementSource()} SELECT DISTINCT l1_category AS value FROM mv ${scope.sql}
       ${scope.sql ? "AND" : "WHERE"} l1_category <> '' ORDER BY 1 LIMIT 200`, scope.params),
    movementQuery<{ value: string }>(
      `${movementSource()} SELECT DISTINCT product_type AS value FROM mv ${scope.sql}
       ${scope.sql ? "AND" : "WHERE"} product_type <> '' ORDER BY 1 LIMIT 200`, scope.params),
    movementQuery<{ value: string }>(
      `${movementSource()} SELECT DISTINCT to_status AS value FROM mv ${scope.sql}
       ${scope.sql ? "AND" : "WHERE"} to_status IS NOT NULL ORDER BY 1 LIMIT 100`, scope.params),
    movementQuery<{ value: string }>(
      `${movementSource()} SELECT operator AS value FROM mv ${scope.sql}
       ${scope.sql ? "AND" : "WHERE"} operator <> ''
       GROUP BY 1 ORDER BY count(*) DESC LIMIT 200`, scope.params),
    movementQuery<{ raw: string; type: MovementType; events: number }>(
      `${movementSource()} SELECT action_raw AS raw, movement_type AS type, count(*)::INT AS events
       FROM mv ${scope.sql} ${scope.sql ? "AND" : "WHERE"} action_raw <> ''
       GROUP BY 1, 2 ORDER BY events DESC LIMIT 100`, scope.params),
  ]);
  const names = whNameByCode();
  return {
    warehouses: warehouses.map((w) => ({
      code: w.wh, name: names.get(w.wh) ?? w.wh, events: Number(w.events),
    })),
    categories: categories.map((r) => r.value),
    product_types: productTypes.map((r) => r.value),
    statuses: statuses.map((r) => r.value),
    operators: operators.map((r) => r.value),
    actions: actions.map((a) => ({ raw: a.raw, type: a.type, events: Number(a.events) })),
  };
}

/**
 * Facet di-cache karena harganya tidak sebanding dengan lajunya berubah: enam
 * agregasi DISTINCT di atas jutaan baris, untuk daftar dropdown yang isinya
 * hanya bertambah ketika WMS memperkenalkan kategori atau ejaan aksi baru.
 * Cache-nya tetap ikut versi database, jadi sinkronisasi berikutnya
 * menyegarkannya sendiri.
 */
export async function getMovementFacets(): Promise<MovementFacets> {
  return readModelCached(
    "movement-facets-v1",
    readModelVersion(),
    loadMovementFacets,
    { freshMs: DASHBOARD_TTL },
  );
}

/**
 * Satu kueri, bukan paginasi.
 *
 * Menyusun ekspor dari halaman 500 baris berarti DuckDB mengurutkan seluruh
 * himpunan hasil sekali per halaman — dua ratus kali untuk berkas terbesar.
 * Batasnya sendiri yang menjadi LIMIT.
 */
export async function getMovementRowsAll(filter: MovementFilter): Promise<MovementRow[]> {
  return movementRowsQuery(filter, MOVEMENT_EXPORT_MAX_ROWS, 0);
}

/**
 * Daftar pendek untuk panel SLOC dan kartu ringkas.
 *
 * Kode SLOC dicocokkan PERSIS di sini, berbeda dari kotak filter tabel yang
 * memang mencari sebagian kata: panel sebuah lokasi tidak boleh menampilkan
 * kejadian milik lokasi lain yang kebetulan kodenya berawalan sama.
 */
export async function getRecentMovements(
  sloc?: string, limit = 12, wh?: string,
): Promise<MovementRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (wh) { clauses.push("mv.wh = ?"); params.push(wh); }
  if (sloc) {
    clauses.push("(mv.source_sloc = ? OR mv.destination_sloc = ?)");
    params.push(sloc, sloc);
  }
  const lim = Math.min(MOVEMENT_PAGE_MAX, Math.max(1, Math.trunc(limit)));
  return movementQuery<MovementRow>(
    `${movementSource()}
     SELECT movement_uid, ${sourceIso("created_at")} AS at, ${sourceIso("updated_at")} AS updated_at,
            wh, location_name, invoice_number, product_id, product_name, sku_number,
            l1_category, product_type, source_sloc, destination_sloc, action_raw,
            movement_type, direction, flow, from_package, to_package,
            from_status, to_status, operator, qty,
            (CASE WHEN direction = 'OUT' THEN -qty ELSE qty END)::DOUBLE AS qty_signed
     FROM mv ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY mv.created_at DESC, mv.movement_uid
     LIMIT ${lim}`,
    params,
  );
}

/**
 * Lokasi yang MELEWATI kapasitas karena ada barang benar-benar masuk ke sana.
 *
 * INI SATU-SATUNYA PEMICU ALERT KAPASITAS
 * ---------------------------------------
 * Versi sebelumnya memindai seluruh lokasi padat pada setiap tick dan
 * memberitakan apa pun yang kebetulan berada di atas ambang. Itu memberitakan
 * KEADAAN, bukan KEJADIAN — dan keadaan tidak berubah di antara tick. Sebuah
 * lokasi yang sudah penuh sejak minggu lalu terus muncul, sementara satu-satunya
 * hal yang benar-benar layak ditindak — seseorang baru saja menaruh barang di
 * tempat yang tidak muat — tenggelam di antaranya. Gudang yang kronis penuh
 * membuat papan alert menjadi daftar yang tidak pernah bisa dikosongkan, dan
 * daftar seperti itu berhenti dibaca.
 *
 * Kueri ini membalik urutannya: mulai dari PERGERAKAN, bukan dari okupansi.
 * Hanya lokasi yang MENERIMA barang di dalam jendela evaluasi yang diperiksa,
 * lalu disaring ke yang kini benar-benar melewati kapasitas. Hasilnya setiap
 * alert selalu dapat menjawab "apa yang berubah, dan siapa yang melakukannya".
 *
 * Ambang "Breach"-nya memakai `statusLadderSQL()` — tangga yang sama persis
 * dengan heatmap, tabel kepadatan, dan ekspor Excel. Alert tidak mungkin
 * menyebut sebuah lokasi Breach sementara layar menyebutnya Kritis.
 */
export interface MovementBreach {
  wh: string;
  sloc_code: string;
  zone: string;
  storage: string;
  basis: Basis;
  pct_qty: number | null;
  pct_cbm: number | null;
  occ_qty: number;
  cap_qty: number;
  occ_cbm: number;
  cap_cbm: number;
  sku_count: number;
  /** Unit yang masuk ke lokasi ini selama jendela evaluasi. */
  qty_in: number;
  /** Berapa kali barang masuk selama jendela itu. */
  events: number;
  /** Pergerakan terakhir yang menambah isi lokasi — penyebab yang disebut alert. */
  last_at: string;
  last_qty: number;
  last_operator: string;
  last_action: string;
  last_product: string;
}

/** Batas kandidat per tick; jendela sepuluh menit tidak pernah mendekatinya. */
export const MOVEMENT_BREACH_MAX = 200;

export async function getMovementBreaches(
  windowHours = 1,
  limit = MOVEMENT_BREACH_MAX,
): Promise<MovementBreach[]> {
  const safeHours = Number.isFinite(windowHours) ? Math.min(72, Math.max(0.1, windowHours)) : 1;
  const safeLimit = Number.isFinite(limit)
    ? Math.min(MOVEMENT_BREACH_MAX, Math.max(1, Math.floor(limit)))
    : MOVEMENT_BREACH_MAX;
  const cap = capacitySqlExpressions();
  return movementQuery<MovementBreach>(
    `${WH_MAP()}, inbound AS (
       SELECT m.wh, v.location_id, trim(v.destination_sloc) AS sloc_code,
              abs(coalesce(v.qty, 0))::DOUBLE AS qty,
              v.created_at,
              coalesce(v.operator, '') AS operator,
              coalesce(v.action_raw, '') AS action_raw,
              coalesce(v.product_name, '') AS product_name
       FROM vw_movement v
       JOIN wh_map m ON m.location_id = v.location_id
       WHERE v.created_at >= ?
         AND nullif(trim(coalesce(v.destination_sloc, '')), '') IS NOT NULL
     ), touched AS (
       SELECT wh, location_id, sloc_code,
              sum(qty)::DOUBLE AS qty_in, count(*)::INT AS events
       FROM inbound GROUP BY 1, 2, 3
     ), latest AS (
       SELECT location_id, sloc_code, created_at, qty, operator, action_raw, product_name
       FROM inbound
       QUALIFY row_number() OVER (
         PARTITION BY location_id, sloc_code ORDER BY created_at DESC
       ) = 1
     ), effective AS MATERIALIZED (
       SELECT v.location_id, v.sloc_code, m.wh, coalesce(v.zone, '') AS zone,
              coalesce(v.rack_zone, '') AS rack_zone, coalesce(v.aisle, '') AS aisle,
              coalesce(v.bay, '') AS bay, coalesce(v.level, '') AS level,
              coalesce(v.bin, '') AS bin,
              coalesce(v.storage_handling, '') AS storage_handling,
              ${cap.basis} AS basis, ${cap.capQty} AS cap_qty, ${cap.capCbm} AS cap_cbm,
              ${cap.qtyValid} AS qty_valid, ${cap.cbmValid} AS cbm_valid
       FROM vw_sloc v ${JOIN_WH}
       JOIN touched tc ON tc.location_id = v.location_id AND tc.sloc_code = v.sloc_code
       WHERE ${OPERATIONAL_SLOC} AND ${zoneEnabledSQL()}
     ), stock_agg AS (
       SELECT e.location_id, e.sloc_code,
              coalesce(sum(s.stock_qty), 0)::DOUBLE AS occ_qty,
              coalesce(sum(s.occupied_cbm), 0)::DOUBLE AS occ_cbm,
              count(DISTINCT s.product_id)::INT AS sku_count
       FROM effective e
       JOIN vw_stock_latest s
         ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
       WHERE ${statusPredicateSQL("s.status")}
         AND ${categoryPredicateSQL("s.l1_category", "e", "e")}
       GROUP BY 1, 2
     ), scored AS (
       SELECT e.*, coalesce(a.occ_qty, 0)::DOUBLE AS occ_qty,
              coalesce(a.occ_cbm, 0)::DOUBLE AS occ_cbm,
              coalesce(a.sku_count, 0)::INT AS sku_count,
              CASE WHEN e.qty_valid AND e.cap_qty > 0
                THEN 100.0 * coalesce(a.occ_qty, 0) / e.cap_qty END AS pct_qty,
              CASE WHEN e.cbm_valid AND e.cap_cbm > 0
                THEN 100.0 * coalesce(a.occ_cbm, 0) / e.cap_cbm END AS pct_cbm
       FROM effective e
       LEFT JOIN stock_agg a
         ON a.location_id = e.location_id AND a.sloc_code = e.sloc_code
     )
     SELECT sc.wh, sc.sloc_code, sc.zone, sc.storage_handling AS storage, sc.basis,
            CASE WHEN sc.pct_qty IS NULL THEN NULL ELSE round(sc.pct_qty, 1) END AS pct_qty,
            CASE WHEN sc.pct_cbm IS NULL THEN NULL ELSE round(sc.pct_cbm, 1) END AS pct_cbm,
            round(sc.occ_qty, 1)::DOUBLE AS occ_qty, round(sc.cap_qty, 1)::DOUBLE AS cap_qty,
            round(sc.occ_cbm, 3)::DOUBLE AS occ_cbm, round(sc.cap_cbm, 3)::DOUBLE AS cap_cbm,
            sc.sku_count, round(tc.qty_in, 1)::DOUBLE AS qty_in, tc.events,
            ${sourceIso("la.created_at")} AS last_at,
            round(la.qty, 1)::DOUBLE AS last_qty,
            la.operator AS last_operator, la.action_raw AS last_action,
            la.product_name AS last_product
     FROM scored sc
     JOIN touched tc ON tc.location_id = sc.location_id AND tc.sloc_code = sc.sloc_code
     JOIN latest la ON la.location_id = sc.location_id AND la.sloc_code = sc.sloc_code
     -- Dulu: Qty Breach ATAU CBM Breach. Satu basis yang lewat sendirian jauh
     -- lebih sering berarti angka master basis itu yang salah daripada lokasi
     -- yang benar-benar penuh, dan alert untuk itu membuat papan tidak terbaca.
     WHERE ${dualBreachSQL("sc.wh", "sc.pct_qty", "sc.pct_cbm")}
     ORDER BY greatest(coalesce(sc.pct_qty, 0), coalesce(sc.pct_cbm, 0)) DESC,
              sc.wh, sc.sloc_code
     LIMIT ${safeLimit}`,
    [sourceCutoff(safeHours)],
  );
}

/** Pencarian cepat untuk command palette: SLOC & produk (dalam allowlist). */
export async function searchData(q: string) {
  const like = `%${q.replace(/'/g, "''")}%`;
  const [slocs, products] = await Promise.all([
    queryHistory<{ sloc_code: string; wh: string; zone: string; storage: string }>(
      `${WH_MAP()}
       SELECT v.sloc_code, m.wh, v.zone, v.storage_handling AS storage
       FROM vw_sloc v ${JOIN_WH}
        WHERE ${OPERATIONAL_SLOC} AND v.sloc_code ILIKE ? ORDER BY v.sloc_code LIMIT 6`, [like]),
    queryHistory<{
      product_name: string; sku_number: string; wh: string;
      zone: string; sloc_code: string; qty: number;
    }>(
      `${WH_MAP()}
       SELECT s.product_name, s.sku_number, m.wh, v.zone, s.sloc_code,
              sum(s.stock_qty)::DOUBLE AS qty
       FROM vw_stock_latest s
       JOIN vw_sloc v
         ON v.location_id = s.location_id AND v.sloc_code = s.sloc_code ${JOIN_WH}
        WHERE ${OPERATIONAL_SLOC} AND (s.product_name ILIKE ? OR s.sku_number ILIKE ?)
       GROUP BY 1, 2, 3, 4, 5
       ORDER BY qty DESC, s.product_name, m.wh, s.sloc_code
       LIMIT 6`, [like, like]),
  ]);
  return { slocs, products };
}

/** Okupansi kedua basis untuk sekumpulan lokasi tertentu. */
export interface SlocBasisReading {
  wh: string;
  sloc_code: string;
  pct_qty: number | null;
  pct_cbm: number | null;
}

/**
 * Bacaan terkini untuk daftar lokasi yang disebut namanya.
 *
 * Mesin alert memerlukan ini untuk menutup alert yang sudah pulih. Daftar
 * lokasi padat dibatasi `max_alerts` demi menjaga volume notifikasi, sehingga
 * "tidak ada di daftar" TIDAK berarti "sudah pulih" — ia bisa saja sekadar
 * kalah peringkat. Sebelumnya penutupan otomatis dilewati sepenuhnya setiap
 * kali daftar penuh, dan di gudang yang memang kronis penuh daftar itu selalu
 * penuh: akibatnya tidak ada satu pun alert lokasi yang pernah tertutup
 * sendiri. Satu kueri bertarget menjawabnya dengan pasti.
 */
export const SLOC_BASIS_READING_MAX = 500;

export async function getSlocBasisReadings(
  codes: Array<{ wh: string; sloc: string }>,
): Promise<Map<string, SlocBasisReading>> {
  const result = new Map<string, SlocBasisReading>();
  const allowed = new Set(getWarehouses().warehouses.map((warehouse) => warehouse.code));
  // Dibatasi supaya satu tick tidak pernah menyusun kueri tak terbatas dari
  // tabel alert yang membesar.
  const wanted = codes
    .filter((entry) => allowed.has(entry.wh) && entry.sloc)
    .slice(0, SLOC_BASIS_READING_MAX);
  if (!wanted.length) return result;

  const cap = capacitySqlExpressions();
  const pairs = wanted
    .map((entry) => `(${sqlString(entry.wh)}, ${sqlString(entry.sloc.toUpperCase())})`)
    .join(", ");
  const rows = await queryHistory<{
    wh: string; sloc_code: string; pct_qty: number | null; pct_cbm: number | null;
  }>(
    `${WH_MAP()}, wanted(wh, sloc_code) AS (VALUES ${pairs}),
     effective AS MATERIALIZED (
       SELECT v.location_id, v.sloc_code, m.wh,
              coalesce(v.zone, '') AS zone, coalesce(v.rack_zone, '') AS rack_zone,
              coalesce(v.aisle, '') AS aisle, coalesce(v.bay, '') AS bay,
              coalesce(v.level, '') AS level, coalesce(v.bin, '') AS bin,
              coalesce(v.storage_handling, '') AS storage_handling,
              ${cap.capQty} AS cap_qty, ${cap.capCbm} AS cap_cbm,
              ${cap.qtyValid} AS qty_valid, ${cap.cbmValid} AS cbm_valid
       FROM vw_sloc v ${JOIN_WH}
       JOIN wanted w ON w.wh = m.wh AND w.sloc_code = v.sloc_code
       WHERE ${OPERATIONAL_SLOC} AND ${zoneEnabledSQL()}
     ), stock_agg AS (
       SELECT e.location_id, e.sloc_code,
              coalesce(sum(s.stock_qty), 0)::DOUBLE AS occ_qty,
              coalesce(sum(s.occupied_cbm), 0)::DOUBLE AS occ_cbm
       FROM effective e
       JOIN vw_stock_latest s
         ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
       WHERE ${statusPredicateSQL("s.status")}
         AND ${categoryPredicateSQL("s.l1_category", "e", "e")}
       GROUP BY 1, 2
     )
     SELECT e.wh, e.sloc_code,
            CASE WHEN e.qty_valid AND e.cap_qty > 0
              THEN round(100.0 * coalesce(a.occ_qty, 0) / e.cap_qty, 1) END AS pct_qty,
            CASE WHEN e.cbm_valid AND e.cap_cbm > 0
              THEN round(100.0 * coalesce(a.occ_cbm, 0) / e.cap_cbm, 1) END AS pct_cbm
     FROM effective e
     LEFT JOIN stock_agg a
       ON a.location_id = e.location_id AND a.sloc_code = e.sloc_code`,
  );
  for (const row of rows) {
    result.set(`${row.wh}|${row.sloc_code}`, {
      wh: row.wh,
      sloc_code: row.sloc_code,
      pct_qty: row.pct_qty === null ? null : Number(row.pct_qty),
      pct_cbm: row.pct_cbm === null ? null : Number(row.pct_cbm),
    });
  }
  return result;
}

// ---- SLOC explorer: satu read-model untuk filter, pencarian, dan ekspor -----
//
// Halaman kepadatan, heatmap, dan ekspor Excel sebelumnya masing-masing
// menyusun kueri sendiri, sehingga tabel di layar dan berkas yang diunduh dapat
// berbeda diam-diam. Semuanya kini melewati satu pembangun SQL: DuckDB yang
// memfilter, mengurutkan, dan menghitung ringkasan, sehingga ekspor "sesuai
// filter" benar-benar berarti sesuai filter yang sedang tampil.

/**
 * Tangga status per gudang sebagai ekspresi SQL — cermin occupancyStatuses().
 *
 * Dua hal harus identik dengan lib/occupancy.ts, dan keduanya pernah menyimpang:
 *
 *  1. Perbandingan batas atasnya `>`, bukan `>=`: isi yang tepat sama dengan
 *     kapasitas maksimum adalah Kritis, bukan Breach.
 *  2. BREACH menuntut KEDUA basis melewati kapasitas. Karena itu ekspresi ini
 *     menerima kedua persentase, bukan satu. Versi sebelumnya hanya menerima
 *     satu angka, dan itulah yang membuat tabel kepadatan serta ekspor Excel
 *     menandai Breach pada lokasi yang di heatmap hanya Kritis.
 *
 * `pctExpr` tetap menentukan rung di bawah Breach — ia adalah persentase pada
 * basis yang sedang ditampilkan.
 */
function statusLadderSQL(
  pctExpr: string,
  whExpr: string,
  qtyExpr: string,
  cbmExpr: string,
): string {
  const ladder = (t: { monitor: number; warning: number; critical: number; breach: number }) => {
    const over = (expr: string) => `${expr} > ${t.breach + CAPACITY_MATCH_TOLERANCE_PCT}`;
    return `CASE WHEN ${over(qtyExpr)} AND ${over(cbmExpr)} THEN 'BREACH'
          WHEN ${pctExpr} >= ${t.critical} THEN 'CRITICAL'
          WHEN ${pctExpr} >= ${t.warning} THEN 'WARNING'
          WHEN ${pctExpr} >= ${t.monitor} THEN 'MONITOR'
          ELSE 'NORMAL' END`;
  };
  let expression = ladder(getThresholds().default);
  for (const warehouse of getWarehouses().warehouses) {
    expression =
      `CASE WHEN ${whExpr} = ${sqlString(warehouse.code)} THEN ${ladder(thresholdsFor(warehouse.code))}
            ELSE ${expression} END`;
  }
  return expression;
}

/** Predikat "lokasi ini Breach" — dipakai mesin alert. */
function dualBreachSQL(whExpr: string, qtyExpr: string, cbmExpr: string): string {
  return `${statusLadderSQL(qtyExpr, whExpr, qtyExpr, cbmExpr)} = 'BREACH'`;
}

export interface SlocExplorerRow {
  sloc_code: string; wh: string; zone: string; rack_zone: string;
  aisle: string; bay: string; level: string; bin: string; storage: string;
  basis: Basis; occupied: boolean;
  occ_qty: number; cap_qty: number; occ_cbm: number; cap_cbm: number;
  /** max_cbm apa adanya dari konfigurasi, sebelum faktor utilisasi volume. */
  cap_cbm_nominal: number;
  /** Faktor utilisasi volume yang berlaku pada lokasi ini (%). */
  utilization_pct: number;
  qty_valid: boolean; cbm_valid: boolean;
  pct_qty: number | null; pct_cbm: number | null; pct_bin: number;
  /** Okupansi basis kebijakan — tetap sama apa pun basis tampilan. */
  pct: number;
  /** Okupansi pada basis tampilan; null bila kapasitasnya belum tersedia. */
  view_pct: number | null;
  status: string;
  sku_count: number;
}

export interface SlocExplorerSummary {
  total: number;
  occupied: number;
  empty: number;
  by_status: Record<string, number>;
  occ_qty: number; cap_qty: number;
  occ_cbm: number; cap_cbm: number;
  sku_count: number;
}

export interface SlocExplorerPage {
  rows: SlocExplorerRow[];
  summary: SlocExplorerSummary;
  offset: number;
  limit: number;
}

/**
 * Batas aman ekspor. Delapan gudang bersama-sama memiliki sekitar 143 ribu SLOC
 * aktif, jadi angka ini memberi ruang lebih dari dua kali lipat tanpa pernah
 * memaksa pengguna mengunduh per bagian, dan tetap jauh di bawah batas baris
 * Excel.
 */
export const SLOC_EXPORT_MAX_ROWS = 400_000;

interface SlocSqlPlan { cte: string; params: unknown[] }

const SLOC_SORT_COLUMNS: Record<SlocSort, string> = {
  sloc_code: "sloc_code",
  wh: "wh",
  zone: "zone",
  rack_zone: "rack_zone",
  storage: "storage_handling",
  pct: "view_pct",
  pct_qty: "pct_qty",
  pct_cbm: "pct_cbm",
  pct_bin: "pct_bin",
  occ_qty: "occ_qty",
  occ_cbm: "occ_cbm",
  sku_count: "sku_count",
};

/** Kolom pencarian digabung sekali agar setiap kata kunci diuji atas semuanya. */
const SLOC_HAYSTACK =
  `lower(sloc_code || ' ' || wh || ' ' || zone || ' ' || rack_zone || ' ' ||
         aisle || ' ' || bay || ' ' || level || ' ' || bin || ' ' || storage_handling)`;

function slocSqlPlan(filter: SlocFilter): SlocSqlPlan {
  const params: unknown[] = [];
  const cap = capacitySqlExpressions();
  // Setiap placeholder di-CAST secara eksplisit. CTE `effective` dirujuk dua
  // kali (oleh stock_agg dan occupancy), dan tanpa CAST penyimpulan tipe
  // parameter DuckDB di dalamnya terbukti rapuh — gejalanya berupa
  // "Expected vector of type VARCHAR, but found vector of type INT32".
  const scope: string[] = [];
  if (filter.wh) { scope.push("m.wh = CAST(? AS VARCHAR)"); params.push(filter.wh); }
  if (filter.zone) {
    scope.push("upper(coalesce(v.zone, '')) = CAST(? AS VARCHAR)");
    params.push(filter.zone);
  }
  if (filter.rackZone) {
    scope.push("upper(coalesce(v.rack_zone, '')) = CAST(? AS VARCHAR)");
    params.push(filter.rackZone);
  }
  if (filter.storage) {
    scope.push("lower(coalesce(v.storage_handling, '')) LIKE CAST(? AS VARCHAR)");
    params.push(`%${filter.storage.toLocaleLowerCase()}%`);
  }

  // Basis tampilan mengikuti UI: kebijakan selalu punya angka (0 bila kosong),
  // sedangkan Qty/CBM boleh NULL supaya "kapasitas belum tersedia" tidak
  // menyamar sebagai 0%.
  const viewExpression =
    filter.view === "qty" ? "pct_qty"
    : filter.view === "cbm" ? "pct_cbm"
    : filter.view === "bin" ? "pct_bin"
    : "coalesce(pct_policy, 0)";
  const statusExpression = filter.view === "bin"
    ? "CASE WHEN occupied THEN 'OCCUPIED' ELSE 'EMPTY' END"
    : `CASE WHEN view_pct IS NULL THEN 'UNAVAILABLE'
            ELSE ${statusLadderSQL("view_pct", "wh", "pct_qty", "pct_cbm")} END`;

  const conditions: string[] = [];
  for (const token of filter.q.toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)) {
    conditions.push(`${SLOC_HAYSTACK} LIKE CAST(? AS VARCHAR)`);
    params.push(`%${token}%`);
  }
  if (filter.fill === "occupied") conditions.push("occupied");
  if (filter.fill === "empty") conditions.push("NOT occupied");
  if (filter.status.length) {
    // Basis Bin melabeli sel EMPTY/OCCUPIED, bukan tangga okupansi, sehingga
    // memaksakan pilihan tangga di sana hanya akan mengosongkan tabel.
    const wanted = filter.view === "bin" ? [] : filter.status;
    if (wanted.length) conditions.push(`status IN (${sqlList(wanted)})`);
  }
  if (filter.minPct !== null) {
    conditions.push("view_pct >= CAST(? AS DOUBLE)");
    params.push(filter.minPct);
  }
  if (filter.maxPct !== null) {
    conditions.push("view_pct <= CAST(? AS DOUBLE)");
    params.push(filter.maxPct);
  }

  const cte =
    `${WH_MAP()}, effective AS MATERIALIZED (
       SELECT v.sloc_id, v.location_id, v.sloc_code, m.wh, coalesce(v.zone, '') AS zone,
              coalesce(v.rack_zone, '') AS rack_zone, coalesce(v.aisle, '') AS aisle,
              coalesce(v.bay, '') AS bay, coalesce(v.level, '') AS level,
              coalesce(v.bin, '') AS bin,
              coalesce(v.storage_handling, '') AS storage_handling,
              ${cap.basis} AS basis, ${cap.capQty} AS cap_qty, ${cap.capCbm} AS cap_cbm,
              ${cap.capCbmNominal} AS cap_cbm_nominal, ${cap.utilization} AS utilization_pct,
              ${cap.qtyValid} AS qty_valid, ${cap.cbmValid} AS cbm_valid
       FROM vw_sloc v ${JOIN_WH}
       WHERE ${OPERATIONAL_SLOC} AND ${zoneEnabledSQL()}${scope.length ? ` AND ${scope.join(" AND ")}` : ""}
     ), stock_agg AS (
       SELECT e.location_id, e.sloc_code,
              coalesce(sum(s.stock_qty), 0)::DOUBLE AS occ_qty,
              coalesce(sum(s.occupied_cbm), 0)::DOUBLE AS occ_cbm,
              count(DISTINCT s.product_id)::INT AS sku_count
       FROM effective e
       JOIN vw_stock_latest s
         ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
       WHERE ${statusPredicateSQL("s.status")}
         AND ${categoryPredicateSQL("s.l1_category", "e", "e")}
       GROUP BY 1, 2
     ), occupancy AS (
       SELECT e.*, coalesce(a.occ_qty, 0)::DOUBLE AS occ_qty,
              coalesce(a.occ_cbm, 0)::DOUBLE AS occ_cbm,
              coalesce(a.sku_count, 0)::INT AS sku_count
       FROM effective e
       LEFT JOIN stock_agg a
         ON a.location_id = e.location_id AND a.sloc_code = e.sloc_code
     ), percentages AS (
       SELECT *,
              CASE WHEN qty_valid AND cap_qty > 0 THEN 100.0 * occ_qty / cap_qty END AS pct_qty,
              CASE WHEN cbm_valid AND cap_cbm > 0 THEN 100.0 * occ_cbm / cap_cbm END AS pct_cbm,
              CASE WHEN occ_qty > 0 OR occ_cbm > 0 THEN 100.0 ELSE 0.0 END AS pct_bin,
              (occ_qty > 0 OR occ_cbm > 0) AS occupied
       FROM occupancy
     ), policy_scored AS (
       SELECT *,
              coalesce(
                CASE WHEN basis = 'qty' THEN pct_qty ELSE pct_cbm END,
                CASE WHEN basis = 'qty' THEN pct_cbm ELSE pct_qty END
              ) AS pct_policy
       FROM percentages
     ), view_scored AS (
       SELECT *, ${viewExpression} AS view_pct FROM policy_scored
     ), labelled AS (
       SELECT *, ${statusExpression} AS status FROM view_scored
     ), filtered AS (
       SELECT * FROM labelled${conditions.length ? `
       WHERE ${conditions.join(" AND ")}` : ""}
     )`;
  return { cte, params };
}

function slocOrderBy(filter: SlocFilter): string {
  const column = SLOC_SORT_COLUMNS[filter.sort] ?? "view_pct";
  const direction = filter.dir === "asc" ? "ASC" : "DESC";
  // NULLS LAST pada kedua arah: baris tanpa kapasitas adalah catatan kualitas
  // data, bukan lokasi paling kosong atau paling penuh.
  return `${column} ${direction} NULLS LAST, wh ASC, sloc_code ASC`;
}

interface SlocRawRow {
  sloc_code: string; wh: string; zone: string; rack_zone: string;
  aisle: string; bay: string; level: string; bin: string; storage_handling: string;
  basis: Basis; occupied: boolean;
  occ_qty: number; cap_qty: number; occ_cbm: number; cap_cbm: number;
  cap_cbm_nominal: number; utilization_pct: number;
  qty_valid: boolean; cbm_valid: boolean;
  pct_qty: number | null; pct_cbm: number | null; pct_bin: number;
  pct_policy: number | null; view_pct: number | null;
  status: string; sku_count: number;
}

const SLOC_SELECT_COLUMNS =
  `sloc_code, wh, zone, rack_zone, aisle, bay, level, bin, storage_handling,
   basis, occupied, occ_qty, cap_qty, occ_cbm, cap_cbm, cap_cbm_nominal,
   utilization_pct, qty_valid, cbm_valid,
   pct_qty, pct_cbm, pct_bin, pct_policy, view_pct, status, sku_count`;

function toExplorerRow(row: SlocRawRow): SlocExplorerRow {
  return {
    sloc_code: row.sloc_code, wh: row.wh, zone: row.zone, rack_zone: row.rack_zone,
    aisle: row.aisle, bay: row.bay, level: row.level, bin: row.bin,
    storage: row.storage_handling, basis: row.basis, occupied: Boolean(row.occupied),
    occ_qty: r1(row.occ_qty), cap_qty: r1(row.cap_qty),
    occ_cbm: r3(row.occ_cbm), cap_cbm: r3(row.cap_cbm),
    cap_cbm_nominal: r4(row.cap_cbm_nominal), utilization_pct: r1(row.utilization_pct),
    qty_valid: Boolean(row.qty_valid), cbm_valid: Boolean(row.cbm_valid),
    pct_qty: row.pct_qty === null ? null : r1(row.pct_qty),
    pct_cbm: row.pct_cbm === null ? null : r1(row.pct_cbm),
    pct_bin: r1(row.pct_bin),
    pct: r1(row.pct_policy ?? 0),
    view_pct: row.view_pct === null ? null : r1(row.view_pct),
    status: row.status,
    sku_count: row.sku_count,
  };
}

const EMPTY_SLOC_SUMMARY: SlocExplorerSummary = {
  total: 0, occupied: 0, empty: 0, by_status: {},
  occ_qty: 0, cap_qty: 0, occ_cbm: 0, cap_cbm: 0, sku_count: 0,
};

function warehouseKnown(code: string): boolean {
  return !code || getWarehouses().warehouses.some((warehouse) => warehouse.code === code);
}

/** Halaman tabel + ringkasan seluruh hasil filter dalam satu perjalanan kueri. */
export async function getSlocExplorerPage(
  filter: SlocFilter,
  offset = 0,
  limit = 100,
): Promise<SlocExplorerPage> {
  refreshCachesForHistoryChange();
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const safeLimit = Number.isFinite(limit)
    ? Math.min(500, Math.max(10, Math.floor(limit)))
    : 100;
  // Kode gudang tak dikenal tidak boleh diam-diam melebar menjadi "semua
  // gudang" — itu menampilkan cakupan yang tidak diminta.
  if (!warehouseKnown(filter.wh)) {
    return { rows: [], summary: EMPTY_SLOC_SUMMARY, offset: safeOffset, limit: safeLimit };
  }

  const plan = slocSqlPlan(filter);
  const countIf = (predicate: string) =>
    `sum(CASE WHEN ${predicate} THEN 1 ELSE 0 END) OVER ()::BIGINT`;
  const rows = await queryHistory<SlocRawRow & {
    total_rows: number; total_occupied: number;
    n_normal: number; n_monitor: number; n_warning: number; n_critical: number;
    n_breach: number; n_unavailable: number;
    sum_occ_qty: number; sum_cap_qty: number; sum_occ_cbm: number; sum_cap_cbm: number;
    sum_sku: number;
  }>(
    `${plan.cte}
     SELECT ${SLOC_SELECT_COLUMNS},
            count(*) OVER ()::BIGINT AS total_rows,
            ${countIf("occupied")} AS total_occupied,
            ${countIf("status = 'NORMAL'")} AS n_normal,
            ${countIf("status = 'MONITOR'")} AS n_monitor,
            ${countIf("status = 'WARNING'")} AS n_warning,
            ${countIf("status = 'CRITICAL'")} AS n_critical,
            ${countIf("status = 'BREACH'")} AS n_breach,
            ${countIf("status = 'UNAVAILABLE'")} AS n_unavailable,
            sum(occ_qty) OVER ()::DOUBLE AS sum_occ_qty,
            sum(CASE WHEN qty_valid THEN cap_qty ELSE 0 END) OVER ()::DOUBLE AS sum_cap_qty,
            sum(occ_cbm) OVER ()::DOUBLE AS sum_occ_cbm,
            sum(CASE WHEN cbm_valid THEN cap_cbm ELSE 0 END) OVER ()::DOUBLE AS sum_cap_cbm,
            sum(sku_count) OVER ()::BIGINT AS sum_sku
     FROM filtered
     ORDER BY ${slocOrderBy(filter)}
     LIMIT ? OFFSET ?`,
    [...plan.params, safeLimit, safeOffset],
  );

  const head = rows[0];
  if (!head) {
    return { rows: [], summary: EMPTY_SLOC_SUMMARY, offset: safeOffset, limit: safeLimit };
  }
  const total = head.total_rows;
  const occupied = head.total_occupied;
  return {
    rows: rows.map(toExplorerRow),
    summary: {
      total,
      occupied,
      empty: Math.max(0, total - occupied),
      by_status: {
        NORMAL: head.n_normal, MONITOR: head.n_monitor, WARNING: head.n_warning,
        CRITICAL: head.n_critical, BREACH: head.n_breach, UNAVAILABLE: head.n_unavailable,
        OCCUPIED: occupied, EMPTY: Math.max(0, total - occupied),
      },
      occ_qty: r1(head.sum_occ_qty), cap_qty: r1(head.sum_cap_qty),
      occ_cbm: r3(head.sum_occ_cbm), cap_cbm: r3(head.sum_cap_cbm),
      sku_count: head.sum_sku,
    },
    offset: safeOffset,
    limit: safeLimit,
  };
}

/**
 * Ringkasan tanpa baris — untuk KPI halaman yang hanya butuh angka.
 *
 * Berbeda dari getSlocExplorerPage, kueri ini tidak mengurutkan 144 ribu lokasi
 * hanya untuk membuang semuanya kecuali hitungannya, dan hasilnya di-cache
 * seperti read-model lain sehingga KPI tidak memindai ulang tiap render.
 */
export async function getSlocSummary(filter: SlocFilter): Promise<SlocExplorerSummary> {
  if (!warehouseKnown(filter.wh)) return EMPTY_SLOC_SUMMARY;
  const cacheKey = createHash("sha1").update(JSON.stringify({
    ...filter, sort: undefined, dir: undefined,
  })).digest("hex").slice(0, 16);
  return readModelCached(
    `sloc-summary-v1-${cacheKey}`,
    readModelVersion(),
    () => loadSlocSummary(filter),
    { freshMs: DASHBOARD_TTL },
  );
}

async function loadSlocSummary(filter: SlocFilter): Promise<SlocExplorerSummary> {
  refreshCachesForHistoryChange();
  const plan = slocSqlPlan(filter);
  const countIf = (predicate: string) => `sum(CASE WHEN ${predicate} THEN 1 ELSE 0 END)::BIGINT`;
  const [row] = await queryHistory<{
    total_rows: number; total_occupied: number;
    n_normal: number; n_monitor: number; n_warning: number; n_critical: number;
    n_breach: number; n_unavailable: number;
    sum_occ_qty: number; sum_cap_qty: number; sum_occ_cbm: number; sum_cap_cbm: number;
    sum_sku: number;
  }>(
    `${plan.cte}
     SELECT count(*)::BIGINT AS total_rows,
            ${countIf("occupied")} AS total_occupied,
            ${countIf("status = 'NORMAL'")} AS n_normal,
            ${countIf("status = 'MONITOR'")} AS n_monitor,
            ${countIf("status = 'WARNING'")} AS n_warning,
            ${countIf("status = 'CRITICAL'")} AS n_critical,
            ${countIf("status = 'BREACH'")} AS n_breach,
            ${countIf("status = 'UNAVAILABLE'")} AS n_unavailable,
            coalesce(sum(occ_qty), 0)::DOUBLE AS sum_occ_qty,
            coalesce(sum(CASE WHEN qty_valid THEN cap_qty ELSE 0 END), 0)::DOUBLE AS sum_cap_qty,
            coalesce(sum(occ_cbm), 0)::DOUBLE AS sum_occ_cbm,
            coalesce(sum(CASE WHEN cbm_valid THEN cap_cbm ELSE 0 END), 0)::DOUBLE AS sum_cap_cbm,
            coalesce(sum(sku_count), 0)::BIGINT AS sum_sku
     FROM filtered`,
    plan.params,
  );
  if (!row) return EMPTY_SLOC_SUMMARY;
  const total = row.total_rows;
  const occupied = row.total_occupied;
  return {
    total,
    occupied,
    empty: Math.max(0, total - occupied),
    by_status: {
      NORMAL: row.n_normal, MONITOR: row.n_monitor, WARNING: row.n_warning,
      CRITICAL: row.n_critical, BREACH: row.n_breach, UNAVAILABLE: row.n_unavailable,
      OCCUPIED: occupied, EMPTY: Math.max(0, total - occupied),
    },
    occ_qty: r1(row.sum_occ_qty), cap_qty: r1(row.sum_cap_qty),
    occ_cbm: r3(row.sum_occ_cbm), cap_cbm: r3(row.sum_cap_cbm),
    sku_count: row.sum_sku,
  };
}

/** Seluruh baris yang cocok dengan filter — sumber tunggal berkas Excel. */
export async function getSlocExplorerAll(
  filter: SlocFilter,
  maxRows = SLOC_EXPORT_MAX_ROWS,
): Promise<SlocExplorerRow[]> {
  refreshCachesForHistoryChange();
  if (!warehouseKnown(filter.wh)) return [];
  const plan = slocSqlPlan(filter);
  const cap = Math.min(SLOC_EXPORT_MAX_ROWS, Math.max(1, Math.floor(maxRows)));
  // LIMIT sengaja diikat sebagai parameter, bukan ditulis sebagai angka.
  // Dengan LIMIT literal, DuckDB salah mengikat placeholder di dalam CTE
  // `effective`: filter gudang mengembalikan nol baris dan filter zona
  // melempar kesalahan tipe — persis kegagalan diam-diam yang membuat berkas
  // ekspor berbeda dari tabel di layar.
  const rows = await queryHistory<SlocRawRow>(
    `${plan.cte}
     SELECT ${SLOC_SELECT_COLUMNS}
     FROM filtered
     ORDER BY ${slocOrderBy(filter)}
     LIMIT ? OFFSET ?`,
    [...plan.params, cap, 0],
  );
  return rows.map(toExplorerRow);
}

export interface SlocFacets {
  warehouses: Array<{ code: string; name: string; sloc_total: number }>;
  zones: Array<{ wh: string; zone: string; rack_zones: string[]; sloc_total: number }>;
  storages: string[];
}

async function loadSlocFacets(): Promise<SlocFacets> {
  const rows = await queryHistory<{
    wh: string; zone: string; rack_zone: string; storage: string; sloc_total: number;
  }>(
    `${WH_MAP()}
     SELECT m.wh, coalesce(v.zone, '') AS zone, coalesce(v.rack_zone, '') AS rack_zone,
            coalesce(v.storage_handling, '') AS storage, count(*)::INT AS sloc_total
     FROM vw_sloc v ${JOIN_WH}
     WHERE ${OPERATIONAL_SLOC} AND ${zoneEnabledSQL()}
     GROUP BY 1, 2, 3, 4
     ORDER BY 1, 2, 3, 4`,
  );
  const names = whNameByCode();
  const warehouses = new Map<string, number>();
  const zones = new Map<string, {
    wh: string; zone: string; rack_zones: Set<string>; sloc_total: number;
  }>();
  const storages = new Set<string>();
  for (const row of rows) {
    warehouses.set(row.wh, (warehouses.get(row.wh) ?? 0) + row.sloc_total);
    const key = `${row.wh}|${row.zone}`;
    const zone = zones.get(key)
      ?? { wh: row.wh, zone: row.zone, rack_zones: new Set<string>(), sloc_total: 0 };
    zone.sloc_total += row.sloc_total;
    if (row.rack_zone) zone.rack_zones.add(row.rack_zone);
    zones.set(key, zone);
    if (row.storage) storages.add(row.storage);
  }
  return {
    warehouses: [...warehouses.entries()]
      .map(([code, sloc_total]) => ({ code, name: names.get(code) ?? code, sloc_total }))
      .sort((a, b) => naturalOrder.compare(a.code, b.code)),
    zones: [...zones.values()]
      .map((zone) => ({
        wh: zone.wh, zone: zone.zone, sloc_total: zone.sloc_total,
        rack_zones: [...zone.rack_zones].sort(naturalOrder.compare),
      }))
      .sort((a, b) => naturalOrder.compare(a.wh, b.wh) || naturalOrder.compare(a.zone, b.zone)),
    storages: [...storages].sort(naturalOrder.compare),
  };
}

/** Pilihan zona/rack/penyimpanan untuk dropdown filter — mengikuti data nyata. */
export async function getSlocFacets(): Promise<SlocFacets> {
  return readModelCached(
    "sloc-facets-v1",
    readModelVersion(),
    loadSlocFacets,
    { freshMs: DASHBOARD_TTL },
  );
}
