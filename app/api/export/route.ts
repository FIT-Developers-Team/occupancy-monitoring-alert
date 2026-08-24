// Ekspor Excel untuk seluruh tabel SLOC/zona.
//
// Satu endpoint, bukan satu per halaman: setiap dataset memakai filter yang
// sama persis dengan tabel di layar, sehingga berkas yang diunduh selalu berisi
// SELURUH baris yang cocok — tanpa paginasi, tanpa pembagian batch, dan tanpa
// kemungkinan tabel dan berkas menyimpang satu sama lain.
import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getT, type TFn } from "@/lib/i18n";
import { getWarehouses, thresholdsFor } from "@/lib/config";
import { parseSlocFilter, type SlocFilter } from "@/lib/sloc-filter";
import { parseMovementFilter } from "@/lib/movements";
import { ALERT_EXPORT_MAX_ROWS, listAlerts } from "@/lib/alerts/store";
import {
  getForecastRows,
  getSlocExplorerAll,
  getWarehouseSummaries,
  getZoneDetail,
  getZoneSummary,
  getMovementRowsAll,
  MOVEMENT_EXPORT_MAX_ROWS,
  SLOC_EXPORT_MAX_ROWS,
  ZONE_DETAIL_EXPORT_MAX_ROWS,
  type SlocExplorerRow,
} from "@/lib/queries";
import { pickViewPct, pickViewStatus } from "@/lib/occupancy-view";
import { buildXlsx, filterSheet, safeFilename, type XlsxColumn, type XlsxSheet } from "@/lib/xlsx";
import type { AlertStatus, BasisMode, Severity, ZoneSummary } from "@/types";

export const dynamic = "force-dynamic";
// Menyusun 143 ribu baris melewati batas 30 detik bawaan pada gudang terbesar.
export const maxDuration = 300;

const DATASETS = [
  "sloc",
  "zone",
  "zone-detail",
  "alerts",
  "forecast",
  "warehouse",
  "movements",
] as const;
type Dataset = (typeof DATASETS)[number];

interface Built {
  sheets: XlsxSheet[];
  filename: string;
  rowCount: number;
}

const stamp = () =>
  new Date().toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" })
    .replace(" ", "_").replace(/:/g, "");

/** Label ringkas filter untuk sheet "Filter" dan potongan nama berkas. */
function slocFilterEntries(filter: SlocFilter, t: TFn): Array<{ label: string; value: string }> {
  const dash = "—";
  return [
    { label: t("common.warehouse"), value: filter.wh || t("common.allWarehouses") },
    { label: t("common.zone"), value: filter.zone || t("common.all") },
    { label: t("export.rackZone"), value: filter.rackZone || t("common.all") },
    { label: t("common.storage"), value: filter.storage || t("common.all") },
    { label: t("action.search"), value: filter.q || dash },
    { label: t("common.status"), value: filter.status.length ? filter.status.join(", ") : t("heat.allStatuses") },
    { label: t("export.fill"), value: t(`export.fill.${filter.fill}`) },
    { label: t("export.range"), value: filter.minPct === null && filter.maxPct === null
      ? dash
      : `${filter.minPct ?? 0}% – ${filter.maxPct ?? "∞"}%` },
    { label: t("basis.label"), value: t(`basis.${filter.view}`) },
  ];
}

function slocFilenameParts(filter: SlocFilter): string[] {
  return [
    filter.wh || "all",
    filter.zone,
    filter.rackZone,
    filter.fill !== "all" ? filter.fill : "",
    filter.status.length === 1 ? filter.status[0].toLowerCase() : "",
  ].filter(Boolean);
}

function slocColumns(t: TFn): XlsxColumn[] {
  return [
    { key: "sloc_code", header: t("common.sloc"), width: 26 },
    { key: "wh", header: t("common.warehouse"), width: 10 },
    { key: "zone", header: t("common.zone"), width: 12 },
    { key: "rack_zone", header: t("export.rackZone"), width: 12 },
    { key: "aisle", header: "Aisle", width: 9 },
    { key: "bay", header: "Bay", width: 9 },
    { key: "level", header: "Level", width: 9 },
    { key: "bin", header: "Bin", width: 9 },
    { key: "storage", header: t("common.storage"), width: 26 },
    { key: "status", header: t("common.status"), width: 14 },
    { key: "fill", header: t("export.fillColumn"), width: 12 },
    { key: "view_pct", header: t("export.viewPct"), type: "percent", width: 14 },
    { key: "pct", header: t("export.policyPct"), type: "percent", width: 14 },
    { key: "pct_qty", header: "% Qty", type: "percent", width: 11 },
    { key: "pct_cbm", header: "% CBM", type: "percent", width: 11 },
    { key: "pct_bin", header: "% Bin", type: "percent", width: 11 },
    { key: "occ_qty", header: t("export.occQty"), type: "number", width: 14 },
    { key: "cap_qty", header: t("export.capQty"), type: "number", width: 14 },
    { key: "occ_cbm", header: t("export.occCbm"), type: "number", width: 14 },
    { key: "cap_cbm", header: t("export.capCbm"), type: "number", width: 14 },
    // Kapasitas nominal + faktor utilisasi ikut diekspor supaya berkas Excel
    // dapat direkonsiliasi langsung dengan angka di halaman Pengaturan:
    // cap_cbm = max_cbm × utilisasi/100.
    { key: "cap_cbm_nominal", header: t("export.capCbmNominal"), type: "number", width: 16 },
    { key: "utilization_pct", header: t("export.utilizationPct"), type: "number", width: 14 },
    { key: "sku_count", header: t("dens.skuCount"), type: "integer", width: 12 },
    { key: "basis", header: t("export.policyBasis"), width: 12 },
  ];
}

function slocSheetRow(row: SlocExplorerRow, t: TFn) {
  return {
    ...row,
    fill: row.occupied ? t("common.filled") : t("common.empty"),
    // Kapasitas yang tidak sahih ditulis kosong, bukan nol: nol berarti
    // "kapasitasnya nol", bukan "kapasitasnya belum diketahui".
    cap_qty: row.qty_valid ? row.cap_qty : null,
    cap_cbm: row.cbm_valid ? row.cap_cbm : null,
    cap_cbm_nominal: row.cbm_valid ? row.cap_cbm_nominal : null,
    basis: row.basis.toUpperCase(),
  };
}

async function buildSloc(params: URLSearchParams, t: TFn): Promise<Built> {
  const filter = parseSlocFilter(params);
  const rows = await getSlocExplorerAll(filter);
  return {
    rowCount: rows.length,
    filename: safeFilename(`wiom-sloc-${slocFilenameParts(filter).join("-")}-${stamp()}`),
    sheets: [
      { name: t("export.sheet.sloc"), columns: slocColumns(t), rows: rows.map((row) => slocSheetRow(row, t)) },
      filterSheet(t("export.sheet.filter"), [
        ...slocFilterEntries(filter, t),
        { label: t("export.rowCount"), value: String(rows.length) },
        { label: t("export.cap"), value: String(SLOC_EXPORT_MAX_ROWS) },
        { label: t("export.generatedAt"), value: stamp() },
      ]),
    ],
  };
}

/** Zona diambil utuh lalu disaring di Node: jumlahnya ratusan, bukan ratusan ribu. */
function filterZones(rows: ZoneSummary[], filter: SlocFilter): ZoneSummary[] {
  const tokens = filter.q.toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  const statuses = new Set(filter.status);
  return rows.filter((row) => {
    if (filter.wh && row.wh !== filter.wh) return false;
    if (filter.zone && row.zone.toUpperCase() !== filter.zone) return false;
    if (filter.storage && !row.storage.toLocaleLowerCase().includes(filter.storage.toLocaleLowerCase())) {
      return false;
    }
    // "Kosong" pada level zona berarti zona yang masih punya SLOC kosong —
    // itulah kapasitas yang benar-benar dapat dipakai hari ini.
    if (filter.fill === "empty" && row.sloc_empty === 0) return false;
    if (filter.fill === "occupied" && row.sloc_occupied === 0) return false;
    const pct = pickViewPct(row, filter.view);
    if (filter.minPct !== null && (pct === null || pct < filter.minPct)) return false;
    if (filter.maxPct !== null && (pct === null || pct > filter.maxPct)) return false;
    if (statuses.size) {
      const status = pct === null ? "UNAVAILABLE" : pickViewStatus(row, filter.view);
      if (!statuses.has(status as never)) return false;
    }
    if (!tokens.length) return true;
    const haystack = `${row.wh} ${row.zone} ${row.storage}`.toLocaleLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

async function buildZone(params: URLSearchParams, t: TFn): Promise<Built> {
  const filter = parseSlocFilter(params);
  const zones = filterZones(await getZoneSummary(filter.wh || undefined), filter);
  const rows = zones.map((zone) => {
    const pct = pickViewPct(zone, filter.view);
    const thresholds = thresholdsFor(zone.wh);
    return {
      wh: zone.wh,
      zone: zone.zone,
      storage: zone.storage,
      status: pct === null ? "UNAVAILABLE" : pickViewStatus(zone, filter.view),
      view_pct: pct,
      pct: zone.pct,
      pct_qty: zone.pct_qty,
      pct_cbm: zone.pct_cbm,
      pct_bin: zone.pct_bin,
      sloc_total: zone.sloc_total,
      sloc_occupied: zone.sloc_occupied,
      sloc_empty: zone.sloc_empty,
      occ_qty: zone.occ_qty,
      cap_qty: zone.cap_qty,
      occ_cbm: zone.occ_cbm,
      cap_cbm: zone.cap_cbm,
      basis: zone.basis.toUpperCase(),
      rack_zones: (zone.rack_zones ?? []).map((rack) => rack.rack_zone).join(", "),
      breach_threshold: thresholds.breach,
    };
  });
  return {
    rowCount: rows.length,
    filename: safeFilename(`wiom-zona-${filter.wh || "all"}-${stamp()}`),
    sheets: [
      {
        name: t("export.sheet.zone"),
        columns: [
          { key: "wh", header: t("common.warehouse"), width: 10 },
          { key: "zone", header: t("common.zone"), width: 14 },
          { key: "storage", header: t("common.storage"), width: 34 },
          { key: "status", header: t("common.status"), width: 14 },
          { key: "view_pct", header: t("export.viewPct"), type: "percent", width: 14 },
          { key: "pct", header: t("export.policyPct"), type: "percent", width: 14 },
          { key: "pct_qty", header: "% Qty", type: "percent", width: 11 },
          { key: "pct_cbm", header: "% CBM", type: "percent", width: 11 },
          { key: "pct_bin", header: "% Bin", type: "percent", width: 11 },
          { key: "sloc_total", header: t("occ.activeSloc"), type: "integer", width: 14 },
          { key: "sloc_occupied", header: t("occ.slocOccupied"), type: "integer", width: 16 },
          { key: "sloc_empty", header: t("occ.emptySloc"), type: "integer", width: 14 },
          { key: "occ_qty", header: t("export.occQty"), type: "number", width: 14 },
          { key: "cap_qty", header: t("export.capQty"), type: "number", width: 14 },
          { key: "occ_cbm", header: t("export.occCbm"), type: "number", width: 14 },
          { key: "cap_cbm", header: t("export.capCbm"), type: "number", width: 14 },
          { key: "basis", header: t("export.policyBasis"), width: 12 },
          { key: "rack_zones", header: t("export.rackZone"), width: 30 },
          { key: "breach_threshold", header: t("export.breachThreshold"), type: "percent", width: 16 },
        ],
        rows,
      },
      filterSheet(t("export.sheet.filter"), [
        ...slocFilterEntries(filter, t),
        { label: t("export.rowCount"), value: String(rows.length) },
        { label: t("export.generatedAt"), value: stamp() },
      ]),
    ],
  };
}

async function buildZoneDetail(params: URLSearchParams, t: TFn): Promise<Built> {
  const wh = (params.get("wh") ?? "").trim().toUpperCase();
  const zone = (params.get("zone") ?? "").trim().toUpperCase();
  if (!wh || !zone) throw new Error("wh & zone wajib diisi.");
  const query = params.get("q") ?? "";
  const status = params.get("stockStatus") ?? "";
  const category = params.get("category") ?? "";
  const rackZone = params.get("rackZone") ?? "";
  const detail = await getZoneDetail(wh, zone, {
    all: true, query, status, category, rackZone,
    sort: "sloc_code", direction: "asc",
  });
  return {
    rowCount: detail.rows.length,
    filename: safeFilename(`wiom-isi-zona-${wh}-${zone}-${stamp()}`),
    sheets: [
      {
        name: t("export.sheet.zoneDetail"),
        columns: [
          { key: "sloc_code", header: t("common.sloc"), width: 26 },
          { key: "rack_zone", header: t("export.rackZone"), width: 12 },
          { key: "storage", header: t("common.storage"), width: 26 },
          { key: "sku_number", header: t("common.skuNo"), width: 16 },
          { key: "product_name", header: t("common.product"), width: 44 },
          { key: "l1_category", header: t("common.category"), width: 22 },
          { key: "status", header: t("common.status"), width: 18 },
          { key: "qty", header: "Qty", type: "number", width: 12 },
          { key: "cbm", header: "CBM", type: "number", width: 12 },
          { key: "sloc_pct", header: t("common.occupancy"), type: "percent", width: 14 },
          { key: "sloc_status", header: t("export.slocStatus"), width: 14 },
          { key: "sloc_basis", header: t("export.policyBasis"), width: 12 },
        ],
        rows: detail.rows.map((row) => ({ ...row, sloc_basis: row.sloc_basis.toUpperCase() })),
      },
      filterSheet(t("export.sheet.filter"), [
        { label: t("common.warehouse"), value: wh },
        { label: t("common.zone"), value: zone },
        { label: t("export.rackZone"), value: rackZone || t("common.all") },
        { label: t("action.search"), value: query || "—" },
        { label: t("common.status"), value: status || t("common.all") },
        { label: t("common.category"), value: category || t("common.all") },
        { label: t("export.rowCount"), value: String(detail.rows.length) },
        { label: t("export.cap"), value: String(ZONE_DETAIL_EXPORT_MAX_ROWS) },
        { label: t("export.generatedAt"), value: stamp() },
      ]),
    ],
  };
}

const ALERT_GROUPS: Record<string, AlertStatus[]> = {
  open: ["NEW", "NOTIFIED"],
  acknowledged: ["ACKNOWLEDGED"],
  closed: ["RESOLVED", "FALSE_POSITIVE"],
  all: ["NEW", "NOTIFIED", "ACKNOWLEDGED", "RESOLVED", "FALSE_POSITIVE"],
};

async function buildAlerts(params: URLSearchParams, t: TFn): Promise<Built> {
  const group = params.get("group") ?? "all";
  const wh = (params.get("wh") ?? "").trim().toUpperCase();
  const severity = (params.get("severity") ?? "").trim().toUpperCase();
  const rule = (params.get("rule") ?? "").trim();
  const query = (params.get("q") ?? "").trim().toLocaleLowerCase();
  const alerts = await listAlerts({
    status: ALERT_GROUPS[group] ?? ALERT_GROUPS.all,
    warehouse: wh || undefined,
    severity: (severity || undefined) as Severity | undefined,
    rule: rule || undefined,
    limit: ALERT_EXPORT_MAX_ROWS,
  });
  const tokens = query.split(/\s+/).filter(Boolean).slice(0, 6);
  const rows = alerts
    .filter((alert) => {
      if (!tokens.length) return true;
      const haystack = [
        alert.warehouse_code, alert.zone, alert.sloc_code, alert.sku,
        alert.title, alert.detail, alert.rule_id,
      ].filter(Boolean).join(" ").toLocaleLowerCase();
      return tokens.every((token) => haystack.includes(token));
    })
    .map((alert) => ({
      alert_id: alert.alert_id,
      created_at: alert.created_at,
      updated_at: alert.updated_at,
      severity: alert.severity,
      status: alert.status,
      warehouse_code: alert.warehouse_code,
      zone: alert.zone ?? "",
      sloc_code: alert.sloc_code ?? "",
      sku: alert.sku ?? "",
      rule_id: alert.rule_id,
      rule_name: alert.rule_name,
      title: alert.title,
      detail: alert.detail,
      occurrences: alert.occurrences,
      escalation_level: alert.escalation_level,
      acknowledged_by: alert.acknowledged_by ?? "",
      acknowledged_at: alert.acknowledged_at ?? "",
      resolved_by: alert.resolved_by ?? "",
      resolved_at: alert.resolved_at ?? "",
      resolution_note: alert.resolution_note ?? "",
    }));
  return {
    rowCount: rows.length,
    filename: safeFilename(`wiom-alert-${group}-${wh || "all"}-${stamp()}`),
    sheets: [
      {
        name: t("export.sheet.alerts"),
        columns: [
          { key: "created_at", header: t("export.createdAt"), width: 22 },
          { key: "severity", header: t("export.severity"), width: 13 },
          { key: "status", header: t("common.status"), width: 16 },
          { key: "warehouse_code", header: t("common.warehouse"), width: 10 },
          { key: "zone", header: t("common.zone"), width: 12 },
          { key: "sloc_code", header: t("common.sloc"), width: 24 },
          { key: "sku", header: t("common.skuNo"), width: 16 },
          { key: "rule_id", header: t("export.rule"), width: 14 },
          { key: "rule_name", header: t("export.ruleName"), width: 30 },
          { key: "title", header: t("export.title"), width: 46 },
          { key: "detail", header: t("audit.column.detail"), width: 56 },
          { key: "occurrences", header: t("alert.occurrences"), type: "integer", width: 12 },
          { key: "escalation_level", header: t("alert.escalation"), type: "integer", width: 12 },
          { key: "acknowledged_by", header: t("export.ackBy"), width: 18 },
          { key: "acknowledged_at", header: t("export.ackAt"), width: 22 },
          { key: "resolved_by", header: t("export.resolvedBy"), width: 18 },
          { key: "resolved_at", header: t("export.resolvedAt"), width: 22 },
          { key: "resolution_note", header: t("export.resolutionNote"), width: 40 },
          { key: "updated_at", header: t("export.updatedAt"), width: 22 },
          { key: "alert_id", header: "ID", width: 24 },
        ],
        rows,
      },
      filterSheet(t("export.sheet.filter"), [
        { label: t("export.group"), value: group },
        { label: t("common.warehouse"), value: wh || t("common.allWarehouses") },
        { label: t("export.severity"), value: severity || t("common.all") },
        { label: t("export.rule"), value: rule || t("common.all") },
        { label: t("action.search"), value: query || "—" },
        { label: t("export.rowCount"), value: String(rows.length) },
        { label: t("export.cap"), value: String(ALERT_EXPORT_MAX_ROWS) },
        { label: t("export.generatedAt"), value: stamp() },
      ]),
    ],
  };
}

async function buildForecast(_params: URLSearchParams, t: TFn): Promise<Built> {
  const rows = await getForecastRows();
  return {
    rowCount: rows.length,
    filename: safeFilename(`wiom-proyeksi-${stamp()}`),
    sheets: [
      {
        name: t("export.sheet.forecast"),
        columns: [
          { key: "warehouse", header: t("common.warehouse"), width: 10 },
          { key: "name", header: t("export.warehouseName"), width: 28 },
          { key: "basis", header: t("export.policyBasis"), width: 12 },
          { key: "current_pct", header: t("common.occupancy"), type: "percent", width: 14 },
          { key: "rate_pct_per_hour", header: t("fc.rate"), type: "number", width: 14 },
          { key: "net_rate", header: t("fc.net"), type: "number", width: 14 },
          { key: "in_rate", header: t("fc.inbound"), type: "number", width: 14 },
          { key: "out_rate", header: t("fc.outbound"), type: "number", width: 14 },
          { key: "hours_to_95", header: t("fc.to95"), type: "number", width: 12 },
          { key: "hours_to_100", header: t("fc.to100"), type: "number", width: 12 },
          { key: "qty_now", header: t("export.qtyNow"), type: "number", width: 14 },
          { key: "bins_now", header: t("occ.slocOccupied"), type: "integer", width: 16 },
          { key: "sloc_total", header: t("occ.activeSloc"), type: "integer", width: 14 },
          { key: "forecast_ready", header: t("export.forecastReady"), width: 16 },
        ],
        rows: rows.map((row) => ({
          ...row,
          basis: row.basis.toUpperCase(),
          forecast_ready: row.forecast_ready ? t("common.active") : t("fc.awaitingHistory"),
        })),
      },
      filterSheet(t("export.sheet.filter"), [
        { label: t("export.rowCount"), value: String(rows.length) },
        { label: t("export.generatedAt"), value: stamp() },
      ]),
    ],
  };
}

async function buildWarehouse(params: URLSearchParams, t: TFn): Promise<Built> {
  const view = (params.get("view") ?? "policy") as BasisMode;
  const summaries = await getWarehouseSummaries();
  return {
    rowCount: summaries.length,
    filename: safeFilename(`wiom-gudang-${stamp()}`),
    sheets: [
      {
        name: t("export.sheet.warehouse"),
        columns: [
          { key: "code", header: t("common.warehouse"), width: 10 },
          { key: "name", header: t("export.warehouseName"), width: 30 },
          { key: "status", header: t("common.status"), width: 14 },
          { key: "view_pct", header: t("export.viewPct"), type: "percent", width: 14 },
          { key: "pct", header: t("export.policyPct"), type: "percent", width: 14 },
          { key: "pct_qty", header: "% Qty", type: "percent", width: 11 },
          { key: "pct_cbm", header: "% CBM", type: "percent", width: 11 },
          { key: "pct_bin", header: "% Bin", type: "percent", width: 11 },
          { key: "sloc_total", header: t("occ.activeSloc"), type: "integer", width: 14 },
          { key: "sloc_occupied", header: t("occ.slocOccupied"), type: "integer", width: 16 },
          { key: "sloc_empty", header: t("occ.emptySloc"), type: "integer", width: 14 },
          { key: "occ_qty", header: t("export.occQty"), type: "number", width: 14 },
          { key: "cap_qty", header: t("export.capQty"), type: "number", width: 14 },
          { key: "occ_cbm", header: t("export.occCbm"), type: "number", width: 14 },
          { key: "cap_cbm", header: t("export.capCbm"), type: "number", width: 14 },
          { key: "rate_pct_per_hour", header: t("fc.rate"), type: "number", width: 14 },
          { key: "hours_to_95", header: t("fc.to95"), type: "number", width: 12 },
          { key: "hours_to_100", header: t("fc.to100"), type: "number", width: 12 },
        ],
        rows: summaries.map((warehouse) => {
          const pct = pickViewPct(warehouse, view);
          return {
            ...warehouse,
            view_pct: pct,
            status: pct === null ? "UNAVAILABLE" : pickViewStatus(warehouse, view),
          };
        }),
      },
      filterSheet(t("export.sheet.filter"), [
        { label: t("basis.label"), value: t(`basis.${view}`) },
        { label: t("export.rowCount"), value: String(summaries.length) },
        { label: t("export.generatedAt"), value: stamp() },
      ]),
    ],
  };
}

/**
 * Ekspor pergerakan stok.
 *
 * Kolomnya sengaja SELENGKAP dataset sumber — paket asal/tujuan, status
 * asal/tujuan, tipe produk, aksi mentah — karena berkas inilah yang dipakai
 * saat menelusuri selisih stok, dan penelusuran seperti itu selalu berhenti
 * pada kolom yang kebetulan tidak ikut diekspor. Tipe kanonik dan aksi mentah
 * berdampingan supaya hasil standardisasi dapat diperiksa ulang.
 */
async function buildMovements(params: URLSearchParams, t: TFn): Promise<Built> {
  const filter = parseMovementFilter(params);
  const rows = await getMovementRowsAll(filter);
  return {
    rowCount: rows.length,
    filename: safeFilename(
      `wiom-movement-${[filter.wh || "all", filter.range].filter(Boolean).join("-")}-${stamp()}`,
    ),
    sheets: [
      {
        name: t("export.sheet.movements"),
        columns: [
          { key: "at", header: t("mv.detail.created"), width: 20 },
          { key: "updated_at", header: t("mv.detail.updated"), width: 20 },
          { key: "wh", header: t("common.warehouse"), width: 10 },
          { key: "location_name", header: t("mv.col.locationName"), width: 26 },
          { key: "invoice_number", header: t("mv.col.invoice"), width: 20 },
          { key: "movement_type", header: t("common.type"), width: 16 },
          { key: "action_raw", header: t("mv.detail.rawAction"), width: 26 },
          { key: "direction", header: t("mv.direction"), width: 12 },
          { key: "flow", header: t("mv.flow"), width: 12 },
          { key: "product_id", header: t("mv.col.productId"), width: 12 },
          { key: "product_name", header: t("common.product"), width: 34 },
          { key: "sku_number", header: t("common.sku"), width: 18 },
          { key: "l1_category", header: t("mv.col.category"), width: 20 },
          { key: "product_type", header: t("mv.col.productType"), width: 18 },
          { key: "source_sloc", header: t("common.from"), width: 26 },
          { key: "destination_sloc", header: t("common.to"), width: 26 },
          { key: "from_package", header: t("mv.col.fromPackage"), width: 18 },
          { key: "to_package", header: t("mv.col.toPackage"), width: 18 },
          { key: "from_status", header: t("mv.col.fromStatus"), width: 14 },
          { key: "to_status", header: t("mv.col.toStatus"), width: 14 },
          { key: "operator", header: t("common.operator"), width: 22 },
          { key: "qty", header: "Qty", type: "number", width: 12 },
          { key: "qty_signed", header: t("mv.col.qtySigned"), type: "number", width: 14 },
        ],
        // Tipe, arah, dan alur ditulis sebagai label bahasa aktif — mengikuti
        // ekspor lain — sementara aksi mentah tetap berdiri sendiri di kolom
        // sebelahnya sebagai nilai sumber yang tidak pernah berubah.
        rows: rows.map((row) => ({
          ...row,
          movement_type: t(`mv.type.${row.movement_type}`),
          direction: t(`mv.direction.${row.direction}`),
          flow: t(`mv.flow.${row.flow}`),
        })),
      },
      filterSheet(t("export.sheet.filter"), [
        { label: t("common.warehouse"), value: filter.wh || t("common.allWarehouses") },
        { label: t("mv.range"), value: t(`mv.range.${filter.range}`) },
        { label: t("common.type"), value: filter.type.length ? filter.type.join(", ") : t("mv.allTypes") },
        { label: t("mv.direction"), value: filter.direction || t("mv.direction.all") },
        { label: t("mv.flow"), value: filter.flow || t("common.all") },
        { label: t("common.sloc"), value: filter.sloc || "—" },
        { label: t("mv.col.category"), value: filter.category || t("common.all") },
        { label: t("mv.col.productType"), value: filter.productType || t("common.all") },
        { label: t("mv.col.toStatus"), value: filter.status || t("common.all") },
        { label: t("common.operator"), value: filter.operator || t("common.all") },
        { label: t("action.search"), value: filter.q || "—" },
        { label: t("export.rowCount"), value: String(rows.length) },
        { label: t("export.cap"), value: String(MOVEMENT_EXPORT_MAX_ROWS) },
        { label: t("export.generatedAt"), value: stamp() },
      ]),
    ],
  };
}

const BUILDERS: Record<Dataset, (params: URLSearchParams, t: TFn) => Promise<Built>> = {
  sloc: buildSloc,
  zone: buildZone,
  "zone-detail": buildZoneDetail,
  alerts: buildAlerts,
  forecast: buildForecast,
  warehouse: buildWarehouse,
  movements: buildMovements,
};

export async function GET(request: NextRequest) {
  // Proxy sudah melindungi seluruh aplikasi; pemeriksaan kedua di sini menjaga
  // agar unduhan massal tidak pernah terlayani ketika hanya proxy yang gagal.
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const params = request.nextUrl.searchParams;
  const dataset = (params.get("dataset") ?? "sloc") as Dataset;
  if (!DATASETS.includes(dataset)) {
    return NextResponse.json({ error: `dataset tidak dikenal: ${dataset}` }, { status: 400 });
  }
  const wh = (params.get("wh") ?? "").trim().toUpperCase();
  if (wh && !getWarehouses().warehouses.some((warehouse) => warehouse.code === wh)) {
    return NextResponse.json({ error: "Warehouse tidak dikenal." }, { status: 400 });
  }

  try {
    const t = await getT();
    const built = await BUILDERS[dataset](params, t);
    const workbook = buildXlsx(built.sheets);
    return new NextResponse(new Uint8Array(workbook), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${built.filename}.xlsx"`,
        "Content-Length": String(workbook.length),
        // Angka okupansi berubah setiap sinkronisasi; berkas lama yang tersimpan
        // di cache perantara akan tampak sah padahal sudah usang.
        "Cache-Control": "no-store, must-revalidate",
        "X-Export-Rows": String(built.rowCount),
      },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
