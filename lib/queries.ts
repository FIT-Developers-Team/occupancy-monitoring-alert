// Read-model v4 atas HISTORY DuckDB.
// KUNCI v4: setiap query WAJIB join `wh_map` (peta location_id → kode WH dari
// config/warehouses.json). Join itu sekaligus ALLOWLIST: lokasi di luar 8 gudang
// (mis. HUB) otomatis tersaring, dan kode WH tidak lagi ditebak dari sloc_code.
// Ditambah filter `active` dan basis ketiga: BIN (SLOC terisi vs kosong).
import { queryHistory } from "@/lib/db";
import { statusFor } from "@/lib/occupancy";
import { wmaRatePctPerHour, hoursToTarget } from "@/lib/forecast";
import { resolveSloc, categoryCounted, countedStatuses } from "@/lib/capacity";
import type { SlocScope } from "@/lib/capacity";
import { getCapacity, getWarehouses, whMapSQL, whNameByCode } from "@/lib/config";
import type {
  SlocOccupancy, WarehouseSummary, ZoneSummary, TrendPoint, ForecastRow, StockLine, Basis, BasisMode,
} from "@/types";

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

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
  return scope.operational || scope.zone ? OPERATIONAL_SLOC : ACTIVE_SLOC;
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
function capacitySqlExpressions(slocAlias = "v", whAlias = "m") {
  const cfg = getCapacity();
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
const DASHBOARD_TTL = 60_000;
const trendCache = new Map<number, { at: number; rows: TrendPoint[] }>();

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
async function getWarehouseBase(): Promise<WarehouseBase[]> {
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
         WHERE ${ACTIVE_SLOC}
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
  stock_without_operational_sloc: number;
}
export async function getOccupancyScopeQuality(): Promise<OccupancyScopeQuality[]> {
  return queryHistory<OccupancyScopeQuality>(
    `${WH_MAP()}, master AS (
       SELECT m.wh AS warehouse,
              count(*) FILTER (WHERE ${ACTIVE_SLOC})::INT AS active_sloc,
              count(*) FILTER (WHERE ${OPERATIONAL_SLOC})::INT AS zoned_sloc,
              count(*) FILTER (WHERE ${ACTIVE_SLOC} AND nullif(trim(v.zone), '') IS NULL)::INT AS active_without_zone
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
            master.active_without_zone,
            coalesce(stock_exception.stock_without_operational_sloc, 0)::INT AS stock_without_operational_sloc
     FROM master LEFT JOIN stock_exception USING (warehouse)
     ORDER BY 1`
  );
}

interface ZoneAggregateRow {
  wh: string; zone: string; storage: string;
  cap_qty: number; cap_cbm: number; n_cbm: number; total: number;
  qty: number; cbm: number; filled: number;
}
const zoneCache = new Map<string, { at: number; rows: ZoneSummary[] }>();

/**
 * Zone cards deliberately do not call getSlocOccupancy(). CBT alone has about
 * 98k racks, and materialising every rack just to draw 15 zone cards made the
 * heatmap wait many seconds. Capacity is resolved from grouped master rows;
 * DuckDB aggregates counted stock and occupied bins at source.
 */
export async function getZoneSummary(wh?: string): Promise<ZoneSummary[]> {
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
       SELECT wh, zone, coalesce(max(nullif(storage_handling, '')), '') AS storage,
              sum(CASE WHEN qty_valid THEN cap_qty ELSE 0 END)::DOUBLE AS cap_qty,
              sum(CASE WHEN cbm_valid THEN cap_cbm ELSE 0 END)::DOUBLE AS cap_cbm,
              sum(CASE WHEN basis = 'cbm' THEN 1 ELSE 0 END)::INT AS n_cbm,
              count(*)::INT AS total
       FROM effective GROUP BY wh, zone
     ), stock AS (
       SELECT e.wh, e.zone,
              coalesce(sum(CASE WHEN e.qty_valid THEN s.stock_qty ELSE 0 END), 0)::DOUBLE AS qty,
              coalesce(sum(CASE WHEN e.cbm_valid THEN s.occupied_cbm ELSE 0 END), 0)::DOUBLE AS cbm
       FROM effective e
       JOIN vw_stock_latest s
         ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
       WHERE ${statusPredicateSQL("s.status")}
         AND ${categoryPredicateSQL("s.l1_category", "e", "e")}
       GROUP BY e.wh, e.zone
     ), filled AS (
       SELECT e.wh, e.zone,
              count(DISTINCT CASE
                WHEN s.stock_qty > 0 OR s.occupied_cbm > 0 THEN e.sloc_id
              END)::INT AS filled
       FROM effective e
       JOIN vw_stock_latest s
         ON s.location_id = e.location_id AND s.sloc_code = e.sloc_code
       WHERE ${statusPredicateSQL("s.status")}
         AND ${categoryPredicateSQL("s.l1_category", "e", "e")}
       GROUP BY e.wh, e.zone
     )
     SELECT c.wh, c.zone, c.storage, c.cap_qty, c.cap_cbm, c.n_cbm, c.total,
            coalesce(s.qty, 0)::DOUBLE AS qty, coalesce(s.cbm, 0)::DOUBLE AS cbm,
            coalesce(f.filled, 0)::INT AS filled
     FROM capacities c
     LEFT JOIN stock s USING (wh, zone)
     LEFT JOIN filled f USING (wh, zone)
     ORDER BY c.wh, c.zone`,
    params,
  );

  const out = rows.map((a) => {
    const basis: Basis = a.n_cbm > a.total / 2 ? "cbm" : "qty";
    const pq = a.cap_qty > 0 ? (a.qty / a.cap_qty) * 100 : null;
    const pv = a.cap_cbm > 0 ? (a.cbm / a.cap_cbm) * 100 : null;
    const pb = a.total > 0 ? (a.filled / a.total) * 100 : 0;
    const pct = (basis === "qty" ? pq : pv) ?? (basis === "qty" ? pv : pq) ?? 0;
    return {
      wh: a.wh, zone: a.zone, storage: a.storage, basis,
      occ_qty: Math.round(a.qty), cap_qty: Math.round(a.cap_qty),
      occ_cbm: r1(a.cbm), cap_cbm: r1(a.cap_cbm),
      pct: r1(pct), pct_qty: pq === null ? null : r1(pq), pct_cbm: pv === null ? null : r1(pv),
      pct_bin: r1(pb), sloc_total: a.total, sloc_occupied: a.filled, sloc_empty: a.total - a.filled,
      status: statusFor(pct, a.wh),
      status_qty: pq === null ? null : statusFor(pq, a.wh),
      status_cbm: pv === null ? null : statusFor(pv, a.wh),
      status_bin: statusFor(pb, a.wh),
    } satisfies ZoneSummary;
  }).sort((a, b) => a.wh.localeCompare(b.wh) || a.zone.localeCompare(b.zone));
  setBoundedCache(zoneCache, cacheKey, { at: Date.now(), rows: out }, 10);
  return out;
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
                PARTITION BY v.zone
                ORDER BY v.rack_zone, v.aisle, v.bay, v.level, v.bin, v.sloc_code
              )::INT AS rn
       FROM vw_sloc v ${JOIN_WH}
       WHERE ${OPERATIONAL_SLOC} AND m.wh = ?
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
      qty_valid: eff.qty_valid, cbm_valid: eff.cbm_valid,
      pct_qty: pq === null ? null : r1(pq), pct_cbm: pv === null ? null : r1(pv),
      occupied, pct_bin: occupied ? 100 : 0, pct: r1(pct),
      status: statusFor(pct, m.wh), status_qty: pq === null ? null : statusFor(pq, m.wh),
      status_cbm: pv === null ? null : statusFor(pv, m.wh), status_bin: "NORMAL",
      product_count: o.pc,
    } satisfies SlocOccupancy;
    (data[m.zone] ??= []).push(cell);
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

  // One bounded query returns the page, its total, and stock aggregates from
  // the same read snapshot. This replaces three connection opens per click.
  const pageRows = await queryHistory<SlocMeta & {
    total: number; l1: string; qty: number; cbm: number; pc: number;
  }>(
    `${WH_MAP()}, scoped AS (
       SELECT v.sloc_id, v.sloc_code, m.wh, v.zone, v.rack_zone, v.aisle, v.bay, v.level, v.bin,
              v.storage_handling AS storage, v.max_quantity, v.max_volume, v.location_id
       FROM vw_sloc v ${JOIN_WH}
       WHERE ${OPERATIONAL_SLOC} AND m.wh = ? AND v.zone = ?
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
    [scope.wh, scope.zone, safeLimit, safeOffset],
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
}
export async function getZoneDetail(
  wh: string,
  zone: string,
  options: ZoneDetailOptions = {},
): Promise<ZoneDetailResult> {
  const scope = cleanScope({ wh, zone, operational: true });
  if (!scope.wh || !scope.zone) return { rows: [], total: 0, truncated: false };
  const safeOffset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset ?? 0)) : 0;
  const safeLimit = Number.isFinite(options.limit)
    ? Math.min(200, Math.max(25, Math.floor(options.limit ?? 100)))
    : 100;
  const query = (options.query ?? "").trim().toLocaleLowerCase().slice(0, 120);
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
       WHERE ${OPERATIONAL_SLOC} AND m.wh = ? AND v.zone = ?
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
    [scope.wh, scope.zone, query, `%${query}%`, safeLimit, safeOffset],
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

export async function getWarehouseTrend(hoursBack = 96): Promise<TrendPoint[]> {
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
       WHERE ${ACTIVE_SLOC}
     )
     SELECT s._synced_at::VARCHAR AS t, e.wh,
            sum(CASE WHEN e.qty_valid THEN s.stock_qty ELSE 0 END)::DOUBLE AS qty,
            sum(CASE WHEN e.cbm_valid THEN s.occupied_cbm ELSE 0 END)::DOUBLE AS cbm,
            count(DISTINCT s.product_id)::INT AS sku,
            count(DISTINCT CASE
              WHEN s.stock_qty > 0 OR s.occupied_cbm > 0
              THEN concat(s.location_id::VARCHAR, '|', s.sloc_code)
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
       WHERE ${ACTIVE_SLOC}
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

export async function getForecastRows(): Promise<ForecastRow[]> {
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

export async function getIntegrity(wh?: string): Promise<IntegrityRow[]> {
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

export async function getIntegrityDrift(limit = 30, wh?: string) {
  return queryHistory(
    `${WH_MAP()}, latest_count AS (
       SELECT *, row_number() OVER (PARTITION BY sloc_code ORDER BY count_date DESC) rn
       FROM cycle_count
     )
     SELECT m.wh AS warehouse, c.sloc_code, c.count_date::VARCHAR AS count_date,
            c.system_qty, c.physical_qty, (c.physical_qty - c.system_qty) AS diff,
            CASE WHEN c.system_qty > 0 AND c.physical_qty = 0 THEN 'PHANTOM'
                 WHEN c.system_qty = 0 AND c.physical_qty > 0 THEN 'GHOST'
                 ELSE 'SELISIH' END AS drift_type
     FROM latest_count c JOIN vw_sloc v ON v.sloc_code = c.sloc_code ${JOIN_WH}
      WHERE c.rn = 1 AND ${OPERATIONAL_SLOC}
       AND abs(c.system_qty - c.physical_qty) > greatest(1, 0.02*c.system_qty)
       ${whFilter(wh)}
     ORDER BY abs(c.physical_qty - c.system_qty) DESC LIMIT ${Math.max(1, limit)}`
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
}
interface DenseAggregateRow {
  sloc_code: string; wh: string; zone: string; storage: string; basis: Basis;
  occ_qty: number; cap_qty: number; occ_cbm: number; cap_cbm: number;
  sku_count: number; pct_qty: number | null; pct_cbm: number | null;
  pct_bin: number; view_pct: number; qty_valid: boolean; cbm_valid: boolean;
}

export async function getDenseSlocs(
  wh?: string, minPct = 90, limit = 200, view: BasisMode = "policy"
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
       WHERE ${OPERATIONAL_SLOC}${scope.wh ? " AND m.wh = ?" : ""}
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
    occ_qty: row.occ_qty, cap_qty: row.cap_qty,
    occ_cbm: row.occ_cbm, cap_cbm: row.cap_cbm, sku_count: row.sku_count,
    pct_qty: row.pct_qty, pct_cbm: row.pct_cbm, pct_bin: row.pct_bin,
    qty_valid: row.qty_valid, cbm_valid: row.cbm_valid,
  }));
}
