// ---- Shared domain types (identifiers English; UI Bahasa Indonesia) ----

export type OccupancyStatus = "NORMAL" | "MONITOR" | "WARNING" | "CRITICAL" | "BREACH";
export type Severity = "INFO" | "WARNING" | "HIGH" | "CRITICAL" | "EMERGENCY";
export type AlertStatus = "NEW" | "NOTIFIED" | "ACKNOWLEDGED" | "RESOLVED" | "FALSE_POSITIVE";
export type Role = "admin" | "supervisor" | "viewer";

export type Basis = "qty" | "cbm";
export type ViewBasis = "qty" | "cbm" | "bin";
export type BasisMode = Basis | "bin" | "policy";

export interface SlocOccupancy {
  sloc_id: number;
  sloc_code: string;
  wh: string;
  zone: string;        // SRA / MZE / CHA (tanpa angka)
  rack_zone: string;   // SRA1
  aisle: string; bay: string; level: string; bin: string;
  storage: string;     // storage handling
  basis: Basis;        // basis kebijakan hasil resolver
  occ_qty: number;
  cap_qty: number;
  occ_cbm: number;
  cap_cbm: number;     // sudah dikali utilisasi
  qty_valid: boolean;  // kapasitas qty layak (master >1 atau di-override)
  cbm_valid: boolean;
  pct_qty: number | null;
  pct_cbm: number | null;
  occupied: boolean;   // basis BIN: lokasi terisi vs kosong
  pct_bin: number;     // 100 bila terisi, 0 bila kosong
  pct: number;         // sesuai basis kebijakan
  status: OccupancyStatus; // status basis kebijakan (dipakai alert)
  status_qty: OccupancyStatus | null;
  status_cbm: OccupancyStatus | null;
  status_bin: OccupancyStatus;
  product_count: number;
}

export interface WarehouseSummary {
  location_id: number;
  code: string;
  name: string;
  basis: Basis;              // basis dominan kebijakan di WH ini
  occ_qty: number; cap_qty: number;   // hanya dari SLOC dgn kapasitas qty valid
  occ_cbm: number; cap_cbm: number;   // hanya dari SLOC dgn kapasitas cbm valid
  pct: number; pct_qty: number | null; pct_cbm: number | null;
  pct_bin: number;                    // SLOC terisi / SLOC aktif
  status: OccupancyStatus; // status basis kebijakan (dipakai alert)
  status_qty: OccupancyStatus | null;
  status_cbm: OccupancyStatus | null;
  status_bin: OccupancyStatus;
  sloc_total: number;
  sloc_occupied: number;
  sloc_empty: number;
  rate_pct_per_hour: number; // basis kebijakan
  hours_to_95: number | null;
  hours_to_100: number | null;
}

export interface ZoneSummary {
  wh: string; zone: string; storage: string; basis: Basis;
  occ_qty: number; cap_qty: number; occ_cbm: number; cap_cbm: number;
  pct: number; pct_qty: number | null; pct_cbm: number | null;
  pct_bin: number;
  sloc_total: number; sloc_empty: number; sloc_occupied: number;
  status: OccupancyStatus; // status basis kebijakan (dipakai alert)
  status_qty: OccupancyStatus | null;
  status_cbm: OccupancyStatus | null;
  status_bin: OccupancyStatus;
}

export interface TrendPoint {
  t: string;
  warehouse: string;
  pct: number;      // basis kebijakan WH
  pct_qty: number;
  pct_cbm: number;
  pct_bin: number;  // % SLOC terisi
  qty: number;      // total unit (utk laju qty)
  sku: number;      // SKU aktif (utk laju sku)
  bins: number;     // jumlah SLOC terisi
}

export interface ForecastRow {
  warehouse: string;
  name: string;
  basis: Basis;
  current_pct: number;
  rate_pct_per_hour: number;
  qty_now: number;                 // total unit (basis-valid)
  sku_now: number;                 // SKU aktif
  qty_rate_per_hour: number;       // Δ unit/jam (WMA)
  sku_rate_per_hour: number;       // Δ SKU/jam (WMA)
  bin_rate_per_hour: number;       // Δ SLOC terisi/jam
  bins_now: number;                // SLOC terisi sekarang
  sloc_total: number;              // SLOC aktif
  cap_basis: number;               // kapasitas efektif pada basis kebijakan
  in_rate: number;                 // inbound per jam (metrik basis)
  out_rate: number;                // outbound per jam (metrik basis)
  flow_unit: string;               // "unit" | "m³"
  hours_to_95: number | null;
  hours_to_100: number | null;
  history_points: number;
  history_span_hours: number;
  forecast_ready: boolean;
  trend: { t: string; pct: number }[];
}

export interface StockLine {
  product_id: number;
  product_name: string;
  sku_number: string;
  l1_category: string;
  status: string;
  qty: number;
  cbm: number;
}

export interface Alert {
  alert_id: string;
  created_at: string;
  updated_at: string;
  rule_id: string;
  rule_name: string;
  severity: Severity;
  warehouse_code: string;
  zone: string | null;
  sloc_code: string | null;
  sku: string | null;
  title: string;
  detail: string;
  status: AlertStatus;
  dedup_key: string;
  occurrences: number;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  escalation_level: number;
  next_escalation_at: string | null;
}

export interface SessionUser {
  username: string;
  role: Role;
  name: string;
}
