// Config-driven policy layer: thresholds, rules, recipients, warehouses,
// capacity, and the per-SKU CBM standards that override the source data.
//
// Bentuk setiap seksi hidup di lib/config-schema.ts. Modul ini hanya menjawab
// "di mana berkasnya", "kapan cache-nya batal", dan "apa yang perlu diperiksa
// lintas berkas sebelum menyimpan".
import fs from "fs";
import {
  CONFIG_SCHEMAS,
  checkConfigCoherence,
  type CapacityConfig,
  type ConfigSection,
  type RecipientsConfig,
  type RulesConfig,
  type SkuStandard,
  type SkuStandardsConfig,
  type ThresholdConfig,
  type WarehousesConfig,
} from "@/lib/config-schema";
import { ensureRuntimeConfigSeeded, resolveConfigFile, writeConfigJsonAtomic } from "@/lib/runtime-config";

export {
  SEVERITY_LEVELS,
  type CapacityConfig,
  type CapacityRuleT,
  type ConfigSection,
  type GoogleChatRouteConfig,
  type OverflowSeverityConfig,
  type RecipientsConfig,
  type RulesConfig,
  type SkuStandard,
  type SkuStandardsConfig,
  type ThresholdConfig,
  type WarehousesConfig,
} from "@/lib/config-schema";

const schemas = CONFIG_SCHEMAS;

// Dijalankan sekali per proses, saat modul kebijakan pertama kali dimuat —
// yaitu sebelum permintaan apa pun sempat membaca konfigurasi.
ensureRuntimeConfigSeeded();

/**
 * Setiap seksi kebijakan disimpan di volume permanen, bukan di dalam image.
 *
 * Sebelumnya hanya `recipients` yang diperlakukan begitu; sisanya ditulis ke
 * `config/*.json` yang ikut dibangun ke image, sehingga ambang, kapasitas, dan
 * daftar gudang yang sudah disimpan admin kembali ke nilai bawaan pada deploy
 * berikutnya. Lihat lib/runtime-config.ts untuk aturan baca/tulis.
 */
function sectionFile(section: ConfigSection, forWrite = false): string {
  return resolveConfigFile(`${section}.json`, forWrite);
}

const cache = new Map<string, { file: string; mtime: number; data: unknown }>();

/**
 * Seksi yang belum punya berkas sama sekali dibaca sebagai objek kosong.
 *
 * Sebuah rilis yang menambahkan seksi baru mendarat di volume yang hanya berisi
 * seksi-seksi lama. Tanpa jalur ini, `statSync` melempar ENOENT pada pembacaan
 * pertama — dan karena kebijakan dibaca sebelum halaman mana pun dirender, itu
 * berarti upgrade mematikan seluruh aplikasi sampai seseorang menaruh berkas
 * kosong di server secara manual. Skema mengisi bawaannya, dan penyimpanan
 * pertama dari halaman Pengaturan membuat berkasnya ada.
 */
function readSectionFallback<T>(section: ConfigSection): T {
  const empty = schemas[section].safeParse({});
  if (!empty.success) {
    // Seksi yang tidak punya bentuk bawaan yang sah — ambang, gudang — memang
    // wajib ada. Sebut berkasnya, karena "default: Required" tidak memberi tahu
    // siapa pun berkas mana yang hilang.
    throw new Error(`Konfigurasi ${section}.json tidak ditemukan dan tidak punya nilai bawaan.`);
  }
  cache.set(section, { file: "", mtime: 0, data: empty.data });
  return empty.data as T;
}

function readSection<T>(section: ConfigSection): T {
  const file = sectionFile(section);
  if (!fs.existsSync(file)) return readSectionFallback<T>(section);
  const stat = fs.statSync(file);
  const hit = cache.get(section);
  // Berkas ikut dibandingkan: begitu penyimpanan pertama memindahkan seksi ini
  // dari seed image ke volume permanen, sumbernya berganti dan cache lama tidak
  // boleh dipakai hanya karena mtime-nya kebetulan sama.
  if (hit && hit.file === file && hit.mtime === stat.mtimeMs) return hit.data as T;
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  const parsed = schemas[section].parse(raw);
  cache.set(section, { file, mtime: stat.mtimeMs, data: parsed });
  return parsed as T;
}

/**
 * Zones switched off for occupancy, keyed `WH|ZONE`.
 *
 * Shared by the SQL predicate in lib/queries.ts and the Node-side checks so a
 * zone can never be excluded from one and counted by the other.
 */
export function disabledZoneKeys(): Set<string> {
  return new Set(getCapacity().disabled_zones.map((entry) => `${entry.wh}|${entry.zone}`));
}

export function isZoneDisabled(warehouseCode: string, zone: string | null | undefined): boolean {
  if (!zone) return false;
  return disabledZoneKeys().has(`${warehouseCode}|${zone}`);
}

export const getThresholds = () => readSection<ThresholdConfig>("thresholds");
export const getRules = () => readSection<RulesConfig>("rules");
export const getRecipients = () => readSection<RecipientsConfig>("recipients");
export const getWarehouses = () => readSection<WarehousesConfig>("warehouses");
export const getCapacity = () => readSection<CapacityConfig>("capacity");

/**
 * Standar CBM per SKU yang ditetapkan admin — menimpa `sku_cbm` sumber data.
 *
 * Di jalur data ini dibaca dari SATU tempat saja: `stockLatestSQL()` di
 * lib/queries.ts, yang membungkus setiap pembacaan stok. Itu disengaja — sebuah
 * override yang hanya berlaku di sebagian layar lebih membingungkan daripada
 * tidak ada override sama sekali.
 */
export const getSkuStandards = () => readSection<SkuStandardsConfig>("sku-standards");

/** Peta SKU (huruf besar) → standar penggantinya. */
export function skuStandardMap(): Map<string, SkuStandard> {
  return new Map(getSkuStandards().standards.map((entry) => [entry.sku, entry]));
}

export function writeSection(section: ConfigSection, data: unknown): unknown {
  const parsed = schemas[section].parse(data);
  // Invarian lintas berkas dinilai pada bentuk sesudah penyimpanan: seksi yang
  // sedang ditulis memakai nilai baru, sisanya nilai yang berlaku sekarang.
  // Satu tempat saja, dipakai bersama pemulihan cadangan (lib/config-schema.ts)
  // sehingga tidak mungkin lagi ada jalan tulis yang lolos pemeriksaan.
  const problems = checkConfigCoherence({
    "warehouses.json": section === "warehouses" ? parsed : getWarehouses(),
    "capacity.json": section === "capacity" ? parsed : getCapacity(),
    "recipients.json": section === "recipients" ? parsed : getRecipients(),
  });
  if (problems.length) throw new Error(problems.join(" "));
  // Penulisan atomik: berkas kebijakan yang terpotong karena proses mati di
  // tengah tulis akan membuat aplikasi gagal start pada restart berikutnya.
  // Recipients memuat URL webhook aktif, sehingga hak aksesnya harus sama
  // ketat dengan sidecar kredensial Superset. Seksi kebijakan lain tidak
  // menyimpan secret dan tetap dapat dibaca worker/service terpisah.
  writeConfigJsonAtomic(sectionFile(section, true), parsed, section === "recipients" ? 0o600 : 0o644);
  cache.delete(section);
  return parsed;
}

export function thresholdsFor(warehouseCode: string) {
  const cfg = getThresholds();
  const o = cfg.overrides[warehouseCode] || {};
  return {
    monitor: o.monitor ?? cfg.default.monitor,
    warning: o.warning ?? cfg.default.warning,
    critical: o.critical ?? cfg.default.critical,
    breach: o.breach ?? cfg.default.breach,
    hysteresis_buffer: o.hysteresis_buffer ?? cfg.default.hysteresis_buffer,
  };
}

export function whByLocationId(): Map<number, { code: string; name: string }> {
  const m = new Map<number, { code: string; name: string }>();
  for (const w of getWarehouses().warehouses) m.set(w.location_id, { code: w.code, name: w.name });
  return m;
}


/** VALUES SQL peta location_id → kode WH (sekaligus ALLOWLIST lokasi). */
export function whMapSQL(): string {
  const rows = getWarehouses().warehouses
    .map((w) => `(${Number(w.location_id)}, '${w.code.replace(/'/g, "''")}')`)
    .join(", ");
  return `wh_map(location_id, wh) AS (VALUES ${rows})`;
}

/** Daftar location_id yang diizinkan tampil (gudang, bukan hub). */
export function allowedLocationIds(): number[] {
  return getWarehouses().warehouses.map((w) => Number(w.location_id));
}

export function whNameByCode(): Map<string, string> {
  return new Map(getWarehouses().warehouses.map((w) => [w.code, w.name]));
}
