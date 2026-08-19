// Read-model v4 atas HISTORY DuckDB.
// KUNCI v4: setiap query WAJIB join `wh_map` (peta location_id → kode WH dari
// config/warehouses.json). Join itu sekaligus ALLOWLIST: lokasi di luar 8 gudang
// (mis. HUB) otomatis tersaring, dan kode WH tidak lagi ditebak dari sloc_code.
// Ditambah filter `active` dan basis ketiga: BIN (SLOC terisi vs kosong).
import { historyDbVersion, queryHistory } from "@/lib/db";
import { createHash } from "node:crypto";
import { statusFor } from "@/lib/occupancy";
import { wmaRatePctPerHour, hoursToTarget } from "@/lib/forecast";
import { resolveSloc, categoryCounted, countedStatuses } from "@/lib/capacity";
import type { SlocScope } from "@/lib/capacity";
import {
  getCapacity, getThresholds, getWarehouses, thresholdsFor, whMapSQL, whNameByCode,
} from "@/lib/config";
import { clearReadModelMemory, readModelCached } from "@/lib/read-model-cache";
import { DRIFT_TYPES, type SlocFilter, type SlocSort } from "@/lib/sloc-filter";
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
const trendCache = new Map<number, { at: number; rows: TrendPoint[] }>();
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
  trendCache.clear();
  zoneCache.clear();
  warehouseBaseCache = null;
  clearReadModelMemory();
  // Memo di bawah sudah membandingkan identitas objek konfigurasi, jadi ia
  // batal dengan sendirinya. Dibersihkan di sini juga supaya satu pemanggilan
  // benar-benar mengembalikan proses ke keadaan tanpa turunan yang tersimpan.
  capacitySqlMemo.clear();
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
      status: statusFor(pct, m.wh),
      status_qty: pq === null ? null : statusFor(pq, m.wh),
      status_cbm: pv === null ? null : statusFor(pv, m.wh),
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
      `${WH_MAP()}, effective AS (
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
        status: statusFor(pct, a.wh),
        status_qty: pq === null ? null : statusFor(pq, a.wh),
        status_cbm: pv === null ? null : statusFor(pv, a.wh),
        status_bin: statusFor(pb, a.wh),
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

async function whCaps() {
  const caps = new Map<string, { capQ: number; capV: number; basis: Basis; slocs: number }>();
  for (const w of await getWarehouseBase()) {
    caps.set(w.code, { capQ: w.cap_qty, capV: w.cap_cbm, basis: w.basis, slocs: w.sloc_total });
  }
  return caps;
}

function withWarehouseTrend(
  base: Array<WarehouseBase | WarehouseSummary>,
  trend: TrendPoint[],
): WarehouseSummary[] {
  return base.map((w) => {
    const pts = trend.filter((t) => t.warehouse === w.code).map((t) => ({ t: t.t, pct: t.pct }));
    const rate = pts.length >= 3 ? wmaRatePctPerHour(pts) : 0;
    return {
      ...w, rate_pct_per_hour: r3(rate),
      hours_to_95: pts.length >= 3 ? hoursToTarget(w.pct, rate, 95) : null,
      hours_to_100: pts.length >= 3 ? hoursToTarget(w.pct, rate, 100) : null,
    };
  });
}

export async function getWarehouseDashboard(hoursBack = 36): Promise<{
  summaries: WarehouseSummary[];
  trend: TrendPoint[];
}> {
  const [base, trend] = await Promise.all([getWarehouseBase(), getWarehouseTrend(hoursBack)]);
  return { summaries: withWarehouseTrend(base, trend), trend };
}

export async function getWarehouseSummaries(): Promise<WarehouseSummary[]> {
  return (await getWarehouseDashboard(36)).summaries;
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
    status: statusFor(pct, row.wh), status_qty: pq === null ? null : statusFor(pq, row.wh),
    status_cbm: pv === null ? null : statusFor(pv, row.wh), status_bin: statusFor(pb, row.wh),
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
    `${WH_MAP()}, effective AS (
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
      status: statusFor(pct, m.wh), status_qty: pq === null ? null : statusFor(pq, m.wh),
      status_cbm: pv === null ? null : statusFor(pv, m.wh), status_bin: "NORMAL",
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
      status: statusFor(pct, m.wh), status_qty: pq === null ? null : statusFor(pq, m.wh),
      status_cbm: pv === null ? null : statusFor(pv, m.wh), status_bin: "NORMAL",
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
  }>(
    `${WH_MAP()}, effective AS (
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
            l1_category, status, qty, cbm, sloc_pct, sloc_basis
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
      sloc_status: statusFor(r.sloc_pct, r.wh),
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

async function loadWarehouseTrend(hoursBack = 96): Promise<TrendPoint[]> {
  refreshCachesForHistoryChange();
  const safeHours = Math.max(1, Math.floor(hoursBack));
  const cached = trendCache.get(safeHours);
  if (cached && Date.now() - cached.at < DASHBOARD_TTL) return cached.rows;
  const caps = await whCaps();
  const cap = capacitySqlExpressions();
  const rows = await queryHistory<{
    t: string; wh: string; qty: number; cbm: number; sku: number; bins: number;
  }>(
    `${WH_MAP()}, effective AS (
       SELECT v.location_id, v.sloc_code, m.wh,
              coalesce(v.zone, '') AS zone, coalesce(v.rack_zone, '') AS rack_zone,
              coalesce(v.aisle, '') AS aisle, coalesce(v.bay, '') AS bay,
              coalesce(v.level, '') AS level, coalesce(v.bin, '') AS bin,
              coalesce(v.storage_handling, '') AS storage_handling,
              ${cap.qtyValid} AS qty_valid, ${cap.cbmValid} AS cbm_valid
       FROM vw_sloc v ${JOIN_WH}
       WHERE ${ACTIVE_SLOC} AND ${zoneEnabledSQL()}
     )
     SELECT s._synced_at::VARCHAR AS t, e.wh,
            sum(CASE WHEN e.qty_valid THEN s.stock_qty ELSE 0 END)::DOUBLE AS qty,
            sum(CASE WHEN e.cbm_valid THEN s.occupied_cbm ELSE 0 END)::DOUBLE AS cbm,
            count(DISTINCT s.product_id)::INT AS sku,
            count(DISTINCT CASE
              WHEN s.stock_qty > 0 OR s.occupied_cbm > 0
              THEN (s.location_id, s.sloc_code)
            END)::INT AS bins
     FROM stock_history s
     JOIN effective e
       ON e.location_id = s.location_id AND e.sloc_code = s.sloc_code
     WHERE s._synced_at >= now() - INTERVAL ${safeHours} HOUR
       AND ${statusPredicateSQL("s.status")}
       AND ${categoryPredicateSQL("s.l1_category", "e", "e")}
     GROUP BY 1, 2 ORDER BY 1 ASC`
  );
  const out = rows.map((r) => {
    const c = caps.get(r.wh) ?? { capQ: 0, capV: 0, basis: "qty" as Basis, slocs: 0 };
    const pq = c.capQ > 0 ? (r.qty / c.capQ) * 100 : 0;
    const pv = c.capV > 0 ? (r.cbm / c.capV) * 100 : 0;
    const pb = c.slocs > 0 ? (r.bins / c.slocs) * 100 : 0;
    const pct = c.basis === "qty" ? (c.capQ > 0 ? pq : pv) : (c.capV > 0 ? pv : pq);
    return { t: r.t, warehouse: r.wh, pct: r1(pct), pct_qty: r1(pq), pct_cbm: r1(pv),
      pct_bin: r1(pb), qty: Math.round(r.qty), sku: r.sku, bins: r.bins };
  });
  setBoundedCache(trendCache, safeHours, { at: Date.now(), rows: out }, 6);
  return out;
}

export async function getWarehouseTrend(hoursBack = 96): Promise<TrendPoint[]> {
  const safeHours = Math.max(1, Math.floor(hoursBack));
  return readModelCached(
    `warehouse-trend-v1-${safeHours}h`,
    readModelVersion(),
    () => loadWarehouseTrend(safeHours),
    { freshMs: DASHBOARD_TTL },
  );
}

/** Estimasi inbound/outbound per jam dari delta snapshot (26 jam terakhir). */
export interface FlowRate { wh: string; in_qty: number; out_qty: number; in_cbm: number; out_cbm: number }
export async function getFlowRates(): Promise<Map<string, FlowRate>> {
  const cap = capacitySqlExpressions();
  const rows = await queryHistory<{
    wh: string; in_qty: number; out_qty: number; in_cbm: number; out_cbm: number; hours: number;
  }>(
    `${WH_MAP()}, effective AS (
       SELECT v.location_id, v.sloc_code, m.wh,
              coalesce(v.zone, '') AS zone, coalesce(v.rack_zone, '') AS rack_zone,
              coalesce(v.aisle, '') AS aisle, coalesce(v.bay, '') AS bay,
              coalesce(v.level, '') AS level, coalesce(v.bin, '') AS bin,
              coalesce(v.storage_handling, '') AS storage_handling,
              ${cap.qtyValid} AS qty_valid, ${cap.cbmValid} AS cbm_valid
       FROM vw_sloc v ${JOIN_WH}
       WHERE ${ACTIVE_SLOC} AND ${zoneEnabledSQL()}
     ), series AS (
       SELECT e.wh, s.location_id, s.sloc_code, s.product_id, s._synced_at AS t,
              CASE WHEN e.qty_valid THEN s.stock_qty ELSE 0 END AS qty,
              CASE WHEN e.cbm_valid THEN s.occupied_cbm ELSE 0 END AS cbm
       FROM stock_history s
       JOIN effective e
         ON e.location_id = s.location_id AND e.sloc_code = s.sloc_code
       WHERE s._synced_at >= now() - INTERVAL 26 HOUR
         AND ${statusPredicateSQL("s.status")}
         AND ${categoryPredicateSQL("s.l1_category", "e", "e")}
     ), d AS (
       SELECT wh, t,
              qty - lag(qty) OVER w AS dq,
              cbm - lag(cbm) OVER w AS dv
       FROM series
       WINDOW w AS (PARTITION BY location_id, sloc_code, product_id ORDER BY t)
     )
     SELECT wh,
            coalesce(sum(CASE WHEN dq > 0 THEN dq END), 0)::DOUBLE  AS in_qty,
            coalesce(-sum(CASE WHEN dq < 0 THEN dq END), 0)::DOUBLE AS out_qty,
            coalesce(sum(CASE WHEN dv > 0 THEN dv END), 0)::DOUBLE  AS in_cbm,
            coalesce(-sum(CASE WHEN dv < 0 THEN dv END), 0)::DOUBLE AS out_cbm,
            greatest(1.0, (epoch(max(t)) - epoch(min(t))) / 3600.0)  AS hours
     FROM d WHERE dq IS NOT NULL GROUP BY wh`
  );
  const m = new Map<string, FlowRate>();
  for (const r of rows) {
    m.set(r.wh, {
      wh: r.wh,
      in_qty: r1(r.in_qty / r.hours), out_qty: r1(r.out_qty / r.hours),
      in_cbm: r3(r.in_cbm / r.hours), out_cbm: r3(r.out_cbm / r.hours),
    });
  }
  return m;
}

async function loadForecastRows(): Promise<ForecastRow[]> {
  const [base, trend, flows] = await Promise.all([
    getWarehouseOccupancySummary(), getWarehouseTrend(48), getFlowRates(),
  ]);
  const sums = withWarehouseTrend(base, trend);
  return sums.map((s) => {
    const pts = trend.filter((t) => t.warehouse === s.code);
    const firstT = pts[0] ? +new Date(pts[0].t) : 0;
    const lastT = pts.length ? +new Date(pts[pts.length - 1].t) : 0;
    const historySpanHours = firstT && lastT > firstT ? (lastT - firstT) / 3_600_000 : 0;
    const forecastReady = pts.length >= 4 && historySpanHours >= 0.25;
    const f = flows.get(s.code) ?? { wh: s.code, in_qty: 0, out_qty: 0, in_cbm: 0, out_cbm: 0 };
    const capBasis = s.basis === "qty" ? s.cap_qty : s.cap_cbm;
    return {
      warehouse: s.code, name: s.name, basis: s.basis,
      current_pct: s.pct, rate_pct_per_hour: forecastReady ? s.rate_pct_per_hour : 0,
      qty_now: s.occ_qty,
      sku_now: pts.length ? pts[pts.length - 1].sku : 0,
      qty_rate_per_hour: forecastReady ? r1(wmaRatePctPerHour(pts.map((p) => ({ t: p.t, pct: p.qty })))) : 0,
      sku_rate_per_hour: forecastReady ? r3(wmaRatePctPerHour(pts.map((p) => ({ t: p.t, pct: p.sku })))) : 0,
      bin_rate_per_hour: forecastReady ? r3(wmaRatePctPerHour(pts.map((p) => ({ t: p.t, pct: p.bins })))) : 0,
      bins_now: s.sloc_occupied, sloc_total: s.sloc_total,
      cap_basis: capBasis,
      in_rate: s.basis === "qty" ? f.in_qty : f.in_cbm,
      out_rate: s.basis === "qty" ? f.out_qty : f.out_cbm,
      flow_unit: s.basis === "qty" ? "unit" : "m³",
      hours_to_95: forecastReady ? s.hours_to_95 : null,
      hours_to_100: forecastReady ? s.hours_to_100 : null,
      history_points: pts.length,
      history_span_hours: r1(historySpanHours),
      forecast_ready: forecastReady,
      trend: pts.map((t) => ({ t: t.t, pct: t.pct })),
    };
  });
}

export async function getForecastRows(): Promise<ForecastRow[]> {
  return readModelCached(
    "forecast-rows-v1",
    readModelVersion(),
    loadForecastRows,
    { freshMs: DASHBOARD_TTL },
  );
}

export async function getSlocDetail(code: string, wh?: string): Promise<{ stock: StockLine[]; movements: unknown[] }> {
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
    queryHistory(
      `${WH_MAP()}, valid AS (
         SELECT v.sloc_code FROM vw_sloc v ${JOIN_WH}
         WHERE ${OPERATIONAL_SLOC}${scope.wh ? " AND m.wh = ?" : ""}
       )
       SELECT movement_id, movement_type, movement_datetime::VARCHAR AS at, operator,
               source_sloc, destination_sloc, product_name, qty
        FROM movement_history
        WHERE EXISTS (SELECT 1 FROM valid WHERE sloc_code = ?)
          AND (source_sloc = ? OR destination_sloc = ?)
        ORDER BY movement_datetime DESC LIMIT 12`,
      scope.wh ? [scope.wh, code, code, code] : [code, code, code],
    ).catch(() => []),
  ]);
  return { stock, movements };
}

export interface IntegrityRow {
  warehouse: string; counted: number; matched: number; integrity_pct: number;
  phantom: number; ghost: number; last_count: string | null;
}
const whFilter = (wh?: string) => (wh ? `AND m.wh = '${wh.replace(/'/g, "''")}'` : "");

async function loadIntegrity(wh?: string): Promise<IntegrityRow[]> {
  return queryHistory<IntegrityRow>(
    `${WH_MAP()}, latest_count AS (
       SELECT *, row_number() OVER (PARTITION BY sloc_code ORDER BY count_date DESC) rn
       FROM cycle_count
     ), c AS (SELECT * FROM latest_count WHERE rn = 1)
     SELECT m.wh AS warehouse,
            count(*)::INT AS counted,
            sum(CASE WHEN abs(c.system_qty - c.physical_qty) <= greatest(1, 0.02*c.system_qty) THEN 1 ELSE 0 END)::INT AS matched,
            round(100.0 * sum(CASE WHEN abs(c.system_qty - c.physical_qty) <= greatest(1, 0.02*c.system_qty) THEN 1 ELSE 0 END) / count(*), 1) AS integrity_pct,
            sum(CASE WHEN c.system_qty > 0 AND c.physical_qty = 0 THEN 1 ELSE 0 END)::INT AS phantom,
            sum(CASE WHEN c.system_qty = 0 AND c.physical_qty > 0 THEN 1 ELSE 0 END)::INT AS ghost,
            max(c.count_date)::VARCHAR AS last_count
     FROM c JOIN vw_sloc v ON v.sloc_code = c.sloc_code ${JOIN_WH}
      WHERE ${OPERATIONAL_SLOC} ${whFilter(wh)}
     GROUP BY 1 ORDER BY 1`
  );
}

export async function getIntegrity(wh?: string): Promise<IntegrityRow[]> {
  const scope = cleanScope({ wh });
  if (wh && !scope.wh) return [];
  return readModelCached(
    `integrity-v1-${scope.wh ?? "all"}`,
    readModelVersion(),
    () => loadIntegrity(scope.wh),
    { freshMs: DASHBOARD_TTL },
  );
}

export interface IntegrityDriftRow {
  warehouse: string; sloc_code: string; count_date: string;
  system_qty: number; physical_qty: number; diff: number; drift_type: string;
}

export interface IntegrityDriftOptions {
  wh?: string;
  /** Pencarian kode SLOC. */
  query?: string;
  /** PHANTOM · GHOST · SELISIH. */
  driftType?: string;
  limit?: number;
}

export async function getIntegrityDrift(
  limit = 30,
  wh?: string,
  options: Omit<IntegrityDriftOptions, "wh" | "limit"> = {},
): Promise<IntegrityDriftRow[]> {
  const scope = cleanScope({ wh });
  if (wh && !scope.wh) return [];
  const safeLimit = Number.isFinite(limit)
    ? Math.min(200_000, Math.max(1, Math.floor(limit)))
    : 30;
  const query = (options.query ?? "").trim().toLocaleLowerCase().slice(0, 80);
  const driftType = (options.driftType ?? "").trim().toUpperCase();
  const safeDriftType = (DRIFT_TYPES as readonly string[]).includes(driftType) ? driftType : "";
  return queryHistory<IntegrityDriftRow>(
    `${WH_MAP()}, latest_count AS (
       SELECT *, row_number() OVER (PARTITION BY sloc_code ORDER BY count_date DESC) rn
       FROM cycle_count
     ), drift AS (
       SELECT m.wh AS warehouse, c.sloc_code, c.count_date::VARCHAR AS count_date,
              c.system_qty, c.physical_qty, (c.physical_qty - c.system_qty) AS diff,
              CASE WHEN c.system_qty > 0 AND c.physical_qty = 0 THEN 'PHANTOM'
                   WHEN c.system_qty = 0 AND c.physical_qty > 0 THEN 'GHOST'
                   ELSE 'SELISIH' END AS drift_type
       FROM latest_count c JOIN vw_sloc v ON v.sloc_code = c.sloc_code ${JOIN_WH}
       WHERE c.rn = 1 AND ${OPERATIONAL_SLOC}
         AND abs(c.system_qty - c.physical_qty) > greatest(1, 0.02*c.system_qty)
         ${whFilter(scope.wh)}
     )
     SELECT * FROM drift
     WHERE (? = '' OR lower(sloc_code || ' ' || warehouse) LIKE ?)
       AND (? = '' OR drift_type = ?)
     ORDER BY abs(diff) DESC, warehouse, sloc_code
     LIMIT ${safeLimit}`,
    [query, `%${query}%`, safeDriftType, safeDriftType],
  );
}

export async function getSyncHealth() {
  const snap = await queryHistory<{ last: string | null; rows: number }>(
    `SELECT max(_synced_at)::VARCHAR AS last, count(*)::BIGINT AS rows FROM stock_history`
  );
  const audit = await queryHistory(
    `SELECT job, mode, finished_at::VARCHAR AS finished_at, rows_written, status
     FROM _sync_audit ORDER BY finished_at DESC LIMIT 8`
  ).catch(() => []);
  return { last_snapshot: snap[0]?.last ?? null, snapshot_rows: snap[0]?.rows ?? 0, recent_syncs: audit };
}

export async function getRecentMovements(sloc?: string, limit = 12, wh?: string) {
  const lim = Math.min(50, Math.max(1, limit));
  if (sloc) {
    return queryHistory(
      `${WH_MAP()}, valid AS (
         SELECT v.sloc_code FROM vw_sloc v ${JOIN_WH} WHERE ${OPERATIONAL_SLOC}
       )
       SELECT movement_id, movement_type, movement_datetime::VARCHAR AS at, operator,
               source_sloc, destination_sloc, product_name, qty
       FROM movement_history
       WHERE EXISTS (SELECT 1 FROM valid WHERE sloc_code = ?)
         AND (source_sloc = ? OR destination_sloc = ?)
       ORDER BY movement_datetime DESC LIMIT ${lim}`, [sloc, sloc, sloc]);
  }
  // hanya movement yang menyentuh SLOC gudang ber-izin
  return queryHistory(
    `${WH_MAP()}, valid AS (
        SELECT v.sloc_code, m.wh FROM vw_sloc v ${JOIN_WH} WHERE ${OPERATIONAL_SLOC}
     )
     SELECT h.movement_id, h.movement_type, h.movement_datetime::VARCHAR AS at, h.operator,
            h.source_sloc, h.destination_sloc, h.product_name, h.qty
     FROM movement_history h
     WHERE EXISTS (SELECT 1 FROM valid x WHERE x.sloc_code IN (h.source_sloc, h.destination_sloc)
                   ${wh ? `AND x.wh = '${wh.replace(/'/g, "''")}'` : ""})
     ORDER BY h.movement_datetime DESC LIMIT ${lim}`);
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

/** Lokasi padat / over-kapasitas + isi SKU-nya (menu Kepadatan). */
export interface DenseSloc {
  sloc_code: string; wh: string; zone: string; storage: string; basis: Basis;
  pct: number; status: string; occ_qty: number; cap_qty: number;
  occ_cbm: number; cap_cbm: number; sku_count: number;
  pct_qty: number | null; pct_cbm: number | null; pct_bin: number;
  qty_valid: boolean; cbm_valid: boolean;
  /** Persentase pada basis yang dipakai untuk memeringkat baris ini. */
  ranking_pct: number;
}
interface DenseAggregateRow {
  sloc_code: string; wh: string; zone: string; storage: string; basis: Basis;
  occ_qty: number; cap_qty: number; occ_cbm: number; cap_cbm: number;
  sku_count: number; pct_qty: number | null; pct_cbm: number | null;
  pct_bin: number; view_pct: number; qty_valid: boolean; cbm_valid: boolean;
}

/**
 * Basis pemeringkatan lokasi padat.
 *
 * Selain empat basis tampilan, mesin alert memakai `"worst"`: yang tertinggi di
 * antara Qty dan CBM. Memeringkat pada basis kebijakan saja adalah cacat asli
 * logika alert — sebuah lokasi yang 5.000% penuh menurut CBM tidak pernah masuk
 * daftar sama sekali bila basis kebijakannya Qty dan Qty-nya masih longgar.
 * Mode ini tidak diekspos ke UI: ia menjawab "mana yang paling parah pada basis
 * apa pun", bukan "apa yang sedang saya lihat".
 */
export type DenseRanking = BasisMode | "worst";

async function loadDenseSlocs(
  wh?: string, minPct = 90, limit = 200, view: DenseRanking = "policy"
): Promise<DenseSloc[]> {
  const scope = cleanScope({ wh, operational: true });
  if (wh && !scope.wh) return [];
  const safeMinimum = Number.isFinite(minPct) ? Math.max(0, minPct) : 90;
  const safeLimit = Number.isFinite(limit) ? Math.min(1_000, Math.max(1, Math.floor(limit))) : 200;
  const cap = capacitySqlExpressions();
  const viewExpression =
    view === "qty" ? "pct_qty"
    : view === "cbm" ? "pct_cbm"
    : view === "bin" ? "pct_bin"
    // greatest() di DuckDB mengabaikan NULL, jadi lokasi yang hanya punya satu
    // kapasitas sahih tetap dinilai dari basis itu alih-alih hilang.
    : view === "worst" ? "greatest(pct_qty, pct_cbm)"
    : "pct";
  const params: unknown[] = scope.wh ? [scope.wh, safeMinimum, safeLimit] : [safeMinimum, safeLimit];

  // Rank at source instead of materialising every operational SLOC in Node.
  // CBT alone can approach 100k active locations; this keeps both memory and
  // response time bounded to the requested priority rows.
  const rows = await queryHistory<DenseAggregateRow>(
    `${WH_MAP()}, effective AS (
       SELECT v.sloc_id, v.location_id, v.sloc_code, m.wh, v.zone,
              coalesce(v.rack_zone, '') AS rack_zone, coalesce(v.aisle, '') AS aisle,
              coalesce(v.bay, '') AS bay, coalesce(v.level, '') AS level,
              coalesce(v.bin, '') AS bin,
              coalesce(v.storage_handling, '') AS storage_handling,
              ${cap.basis} AS basis, ${cap.capQty} AS cap_qty, ${cap.capCbm} AS cap_cbm,
              ${cap.qtyValid} AS qty_valid, ${cap.cbmValid} AS cbm_valid
       FROM vw_sloc v ${JOIN_WH}
       WHERE ${OPERATIONAL_SLOC} AND ${zoneEnabledSQL()}${scope.wh ? " AND m.wh = ?" : ""}
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
       SELECT e.*, coalesce(s.occ_qty, 0)::DOUBLE AS occ_qty,
              coalesce(s.occ_cbm, 0)::DOUBLE AS occ_cbm,
              coalesce(s.sku_count, 0)::INT AS sku_count
       FROM effective e
       LEFT JOIN stock_agg s
         ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
     ), percentages AS (
       SELECT *,
              CASE WHEN qty_valid AND cap_qty > 0 THEN 100.0 * occ_qty / cap_qty END AS pct_qty,
              CASE WHEN cbm_valid AND cap_cbm > 0 THEN 100.0 * occ_cbm / cap_cbm END AS pct_cbm,
              CASE WHEN occ_qty > 0 OR occ_cbm > 0 THEN 100.0 ELSE 0.0 END AS pct_bin
       FROM occupancy
     ), policy_scored AS (
       SELECT *,
              coalesce(
                CASE WHEN basis = 'qty' THEN pct_qty ELSE pct_cbm END,
                CASE WHEN basis = 'qty' THEN pct_cbm ELSE pct_qty END,
                0
              ) AS pct
       FROM percentages
     ), view_scored AS (
       SELECT *, ${viewExpression} AS view_pct
       FROM policy_scored
     )
     SELECT sloc_code, wh, zone, storage_handling AS storage, basis,
            round(occ_qty, 1)::DOUBLE AS occ_qty, round(cap_qty, 1)::DOUBLE AS cap_qty,
            round(occ_cbm, 3)::DOUBLE AS occ_cbm, round(cap_cbm, 3)::DOUBLE AS cap_cbm,
            sku_count,
            CASE WHEN pct_qty IS NULL THEN NULL ELSE round(pct_qty, 1)::DOUBLE END AS pct_qty,
            CASE WHEN pct_cbm IS NULL THEN NULL ELSE round(pct_cbm, 1)::DOUBLE END AS pct_cbm,
            round(pct_bin, 1)::DOUBLE AS pct_bin,
            round(view_pct, 1)::DOUBLE AS view_pct,
            qty_valid, cbm_valid
     FROM view_scored
     WHERE view_pct IS NOT NULL AND view_pct >= ?
     ORDER BY view_pct DESC, wh, sloc_code
     LIMIT ?`,
    params,
  );
  return rows.map((row) => ({
    sloc_code: row.sloc_code, wh: row.wh, zone: row.zone, storage: row.storage,
    basis: row.basis, pct: row.view_pct,
    status: view === "bin" ? "NORMAL" : statusFor(row.view_pct, row.wh),
    ranking_pct: row.view_pct,
    occ_qty: row.occ_qty, cap_qty: row.cap_qty,
    occ_cbm: row.occ_cbm, cap_cbm: row.cap_cbm, sku_count: row.sku_count,
    pct_qty: row.pct_qty, pct_cbm: row.pct_cbm, pct_bin: row.pct_bin,
    qty_valid: row.qty_valid, cbm_valid: row.cbm_valid,
  }));
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
     effective AS (
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

export async function getDenseSlocs(
  wh?: string, minPct = 90, limit = 200, view: DenseRanking = "policy"
): Promise<DenseSloc[]> {
  const scope = cleanScope({ wh });
  if (wh && !scope.wh) return [];
  const safeMinimum = Number.isFinite(minPct) ? Math.max(0, minPct) : 90;
  const safeLimit = Number.isFinite(limit) ? Math.min(1_000, Math.max(1, Math.floor(limit))) : 200;
  const safeView: DenseRanking =
    ["qty", "cbm", "bin", "policy", "worst"].includes(view) ? view : "policy";
  return readModelCached(
    `dense-sloc-v1-${scope.wh ?? "all"}-${safeMinimum}-${safeLimit}-${safeView}`,
    readModelVersion(),
    () => loadDenseSlocs(scope.wh, safeMinimum, safeLimit, safeView),
    { freshMs: DASHBOARD_TTL },
  );
}

// ---- SLOC explorer: satu read-model untuk filter, pencarian, dan ekspor -----
//
// Halaman kepadatan, heatmap, dan ekspor Excel sebelumnya masing-masing
// menyusun kueri sendiri, sehingga tabel di layar dan berkas yang diunduh dapat
// berbeda diam-diam. Semuanya kini melewati satu pembangun SQL: DuckDB yang
// memfilter, mengurutkan, dan menghitung ringkasan, sehingga ekspor "sesuai
// filter" benar-benar berarti sesuai filter yang sedang tampil.

/** Tangga status per gudang sebagai ekspresi SQL (cermin statusFor()). */
function statusLadderSQL(pctExpr: string, whExpr: string): string {
  const ladder = (t: { monitor: number; warning: number; critical: number; breach: number }) =>
    `CASE WHEN ${pctExpr} >= ${t.breach} THEN 'BREACH'
          WHEN ${pctExpr} >= ${t.critical} THEN 'CRITICAL'
          WHEN ${pctExpr} >= ${t.warning} THEN 'WARNING'
          WHEN ${pctExpr} >= ${t.monitor} THEN 'MONITOR'
          ELSE 'NORMAL' END`;
  let expression = ladder(getThresholds().default);
  for (const warehouse of getWarehouses().warehouses) {
    expression =
      `CASE WHEN ${whExpr} = ${sqlString(warehouse.code)} THEN ${ladder(thresholdsFor(warehouse.code))}
            ELSE ${expression} END`;
  }
  return expression;
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
    : `CASE WHEN view_pct IS NULL THEN 'UNAVAILABLE' ELSE ${statusLadderSQL("view_pct", "wh")} END`;

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
    `${WH_MAP()}, effective AS (
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
