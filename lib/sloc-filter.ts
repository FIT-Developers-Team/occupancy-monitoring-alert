// Kontrak filter tabel (SLOC, zona, selisih cycle count) yang dipakai bersama
// oleh halaman server, komponen klien, endpoint JSON, dan ekspor Excel.
//
// Satu sumber kebenaran itu disengaja: kalau tabel dan tombol ekspor menyusun
// kueri sendiri-sendiri, berkas yang diunduh cepat atau lambat tidak lagi sama
// dengan yang dilihat di layar — dan itu justru kesalahan yang paling mahal
// pada laporan okupansi.
import type { BasisMode } from "@/types";

export const SLOC_STATUSES = [
  "NORMAL",
  "MONITOR",
  "WARNING",
  "CRITICAL",
  "BREACH",
  "UNAVAILABLE",
] as const;
export type SlocStatusFilter = (typeof SLOC_STATUSES)[number];

/** Terisi vs kosong berdiri sendiri dari tangga status okupansi. */
export const FILL_MODES = ["all", "occupied", "empty"] as const;
export type FillMode = (typeof FILL_MODES)[number];

export const SLOC_SORTS = [
  "sloc_code",
  "wh",
  "zone",
  "rack_zone",
  "storage",
  "pct",
  "pct_qty",
  "pct_cbm",
  "pct_bin",
  "occ_qty",
  "occ_cbm",
  "sku_count",
] as const;
export type SlocSort = (typeof SLOC_SORTS)[number];

export const BASIS_MODES = ["policy", "qty", "cbm", "bin"] as const;

export interface SlocFilter {
  wh: string;
  zone: string;
  rackZone: string;
  storage: string;
  /** Pencarian bebas: kode SLOC, zona, rack, aisle/bay/level/bin, penyimpanan. */
  q: string;
  status: SlocStatusFilter[];
  fill: FillMode;
  minPct: number | null;
  maxPct: number | null;
  view: BasisMode;
  sort: SlocSort;
  dir: "asc" | "desc";
}

export const EMPTY_SLOC_FILTER: SlocFilter = {
  wh: "",
  zone: "",
  rackZone: "",
  storage: "",
  q: "",
  status: [],
  fill: "all",
  minPct: null,
  maxPct: null,
  view: "policy",
  sort: "pct",
  dir: "desc",
};

const STATUS_SET = new Set<string>(SLOC_STATUSES);
const SORT_SET = new Set<string>(SLOC_SORTS);
const FILL_SET = new Set<string>(FILL_MODES);
const BASIS_SET = new Set<string>(BASIS_MODES);

function boundedPercent(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  // Nilai di atas 100% bermakna (over-kapasitas), jadi hanya batas bawah yang
  // dipaksakan; batas atas dilonggarkan sampai 1000% seperti ambang alert SLOC.
  if (!Number.isFinite(value)) return null;
  return Math.min(1000, Math.max(0, Math.round(value * 10) / 10));
}

/** Normalisasi query string apa pun menjadi filter yang aman dipakai di SQL. */
export function parseSlocFilter(params: URLSearchParams): SlocFilter {
  const statusRaw = (params.get("status") ?? "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => STATUS_SET.has(value)) as SlocStatusFilter[];
  const fill = (params.get("fill") ?? "all").trim().toLowerCase();
  const view = (params.get("view") ?? "policy").trim().toLowerCase();
  const sort = (params.get("sort") ?? "pct").trim().toLowerCase();
  const minPct = boundedPercent(params.get("min"));
  const maxPct = boundedPercent(params.get("max"));

  return {
    wh: (params.get("wh") ?? "").trim().toUpperCase().slice(0, 12),
    zone: (params.get("zone") ?? "").trim().toUpperCase().slice(0, 40),
    rackZone: (params.get("rackZone") ?? "").trim().toUpperCase().slice(0, 40),
    storage: (params.get("storage") ?? "").trim().slice(0, 80),
    q: (params.get("q") ?? "").trim().slice(0, 120),
    status: [...new Set(statusRaw)],
    fill: (FILL_SET.has(fill) ? fill : "all") as FillMode,
    // Rentang terbalik disusun ulang, bukan ditolak: pengguna yang mengetik
    // 100–90 jelas memaksudkan 90–100 dan tidak layak mendapat tabel kosong.
    minPct: minPct !== null && maxPct !== null ? Math.min(minPct, maxPct) : minPct,
    maxPct: minPct !== null && maxPct !== null ? Math.max(minPct, maxPct) : maxPct,
    view: (BASIS_SET.has(view) ? view : "policy") as BasisMode,
    sort: (SORT_SET.has(sort) ? sort : "pct") as SlocSort,
    dir: params.get("dir") === "asc" ? "asc" : "desc",
  };
}

/** Kebalikan parseSlocFilter — dipakai klien untuk menyusun URL data & ekspor. */
export function slocFilterParams(filter: SlocFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.wh) params.set("wh", filter.wh);
  if (filter.zone) params.set("zone", filter.zone);
  if (filter.rackZone) params.set("rackZone", filter.rackZone);
  if (filter.storage) params.set("storage", filter.storage);
  if (filter.q) params.set("q", filter.q);
  if (filter.status.length) params.set("status", filter.status.join(","));
  if (filter.fill !== "all") params.set("fill", filter.fill);
  if (filter.minPct !== null) params.set("min", String(filter.minPct));
  if (filter.maxPct !== null) params.set("max", String(filter.maxPct));
  if (filter.view !== "policy") params.set("view", filter.view);
  if (filter.sort !== "pct") params.set("sort", filter.sort);
  if (filter.dir !== "desc") params.set("dir", filter.dir);
  return params;
}

export function isDefaultSlocFilter(filter: SlocFilter): boolean {
  return (
    !filter.wh && !filter.zone && !filter.rackZone && !filter.storage && !filter.q &&
    filter.status.length === 0 && filter.fill === "all" &&
    filter.minPct === null && filter.maxPct === null
  );
}

/** Jumlah kriteria aktif — dipakai badge "n filter" pada toolbar. */
export function activeSlocFilterCount(filter: SlocFilter): number {
  return [
    filter.wh, filter.zone, filter.rackZone, filter.storage, filter.q,
    filter.status.length ? "status" : "",
    filter.fill !== "all" ? "fill" : "",
    filter.minPct !== null ? "min" : "",
    filter.maxPct !== null ? "max" : "",
  ].filter(Boolean).length;
}

/**
 * Jenis selisih cycle count. Berada di modul ini, bukan di lib/queries, karena
 * tabel selisih adalah komponen klien: mengimpor nilai apa pun dari read-model
 * akan menarik DuckDB ke dalam bundel browser.
 */
export const DRIFT_TYPES = ["PHANTOM", "GHOST", "SELISIH"] as const;
export type DriftType = (typeof DRIFT_TYPES)[number];
