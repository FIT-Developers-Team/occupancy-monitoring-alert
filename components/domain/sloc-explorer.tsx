"use client";
// Penjelajah SLOC: pencarian, filter, urutan, dan ekspor Excel di atas satu
// read-model.
//
// Filter dikerjakan di server. Menyaring di browser berarti mengirim seluruh
// 143 ribu lokasi terlebih dahulu — itu bukan hanya lambat, tetapi juga membuat
// jumlah pada ringkasan hanya menghitung halaman yang kebetulan sudah dimuat.
// Karena tabel dan tombol ekspor memakai parameter yang sama persis, berkas
// Excel selalu berisi tepat baris yang sedang dilihat pengguna — seluruhnya,
// bukan satu halaman.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { BasisMode, OccupancyStatus, StockLine } from "@/types";
import { STATUS_COLOR } from "@/lib/status-tone";
import type { SlocExplorerRow, SlocExplorerSummary, SlocFacets } from "@/lib/queries";
import {
  EMPTY_SLOC_FILTER,
  SLOC_STATUSES,
  activeSlocFilterCount,
  isDefaultSlocFilter,
  slocFilterParams,
  type FillMode,
  type SlocFilter,
  type SlocSort,
  type SlocStatusFilter,
} from "@/lib/sloc-filter";
import { formatters } from "@/lib/utils";
import { trapFocus } from "@/lib/focus-trap";
import { useT } from "@/lib/i18n-client";
import { StatusBadge } from "@/components/ui/badges";
import ExportExcelButton from "@/components/domain/export-excel-button";

const PAGE_SIZES = [50, 100, 200, 500];
const LADDER_STATUSES = SLOC_STATUSES.filter((status) => status !== "UNAVAILABLE");

/** Preset satu klik untuk pertanyaan yang paling sering ditanyakan operasional. */
type PresetId = "breach" | "dense" | "empty" | "unavailable";
const PRESETS: Array<{
  id: PresetId;
  labelKey: string;
  patch: Partial<SlocFilter>;
}> = [
  {
    id: "breach",
    labelKey: "slocx.preset.breach",
    patch: { status: ["CRITICAL", "BREACH"], fill: "all", minPct: null, maxPct: null },
  },
  {
    id: "dense",
    labelKey: "slocx.preset.dense",
    patch: { status: [], fill: "all", minPct: 90, maxPct: null },
  },
  {
    id: "empty",
    labelKey: "slocx.preset.empty",
    patch: { status: [], fill: "empty", minPct: null, maxPct: null },
  },
  {
    id: "unavailable",
    labelKey: "slocx.preset.unavailable",
    patch: { status: ["UNAVAILABLE"], fill: "all", minPct: null, maxPct: null },
  },
];

const EMPTY_SUMMARY: SlocExplorerSummary = {
  total: 0, occupied: 0, empty: 0, by_status: {},
  occ_qty: 0, cap_qty: 0, occ_cbm: 0, cap_cbm: 0, sku_count: 0,
};

/**
 * Warna angka okupansi = warna statusnya.
 *
 * Baris yang belum punya kapasitas sahih tetap netral: "belum diketahui" bukan
 * salah satu tingkat pada tangga status.
 */
function rowColor(row: SlocExplorerRow): string {
  if (row.view_pct === null) return "var(--text-muted)";
  const status = row.status as OccupancyStatus;
  return STATUS_COLOR[status] ?? "var(--text)";
}

function statusTone(status: string): string {
  if (status === "OCCUPIED") return "badge badge-monitor";
  if (status === "EMPTY") return "badge";
  if (status === "UNAVAILABLE") return "badge";
  return "";
}

export default function SlocExplorer({
  lockedWh,
  lockedZone,
  initialFilter,
  initialView = "policy",
  storageKey,
  syncUrl = false,
}: {
  /** Halaman gudang/zona mengunci cakupannya agar filter tidak keluar konteks. */
  lockedWh?: string;
  lockedZone?: string;
  initialFilter?: Partial<SlocFilter>;
  initialView?: BasisMode;
  /** Kunci penyimpanan preferensi baris per halaman. */
  storageKey?: string;
  syncUrl?: boolean;
}) {
  const { t, lang } = useT();
  const f = formatters(lang);
  // Satu sumber locale untuk seluruh komponen ini: `toLocaleString` di bawah
  // dan pemformat bersama harus tidak mungkin memakai konvensi yang berbeda.
  const locale = f.locale;

  const [filter, setFilter] = useState<SlocFilter>(() => ({
    ...EMPTY_SLOC_FILTER,
    view: initialView,
    ...initialFilter,
    ...(lockedWh ? { wh: lockedWh } : {}),
    ...(lockedZone ? { zone: lockedZone } : {}),
  }));
  const [queryInput, setQueryInput] = useState(filter.q);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [rows, setRows] = useState<SlocExplorerRow[]>([]);
  const [summary, setSummary] = useState<SlocExplorerSummary>(EMPTY_SUMMARY);
  const [facets, setFacets] = useState<SlocFacets | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selected, setSelected] = useState<SlocExplorerRow | null>(null);
  const [stock, setStock] = useState<StockLine[]>([]);
  const [stockLoading, setStockLoading] = useState(false);
  const drawerTrigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;
    const stored = Number(window.localStorage.getItem(`wiom.slocx.size.${storageKey}`));
    if (PAGE_SIZES.includes(stored)) setPageSize(stored);
  }, [storageKey]);

  // Kotak pencarian diketik bebas; permintaan baru menunggu jeda agar satu kata
  // tidak menghasilkan satu kueri per huruf.
  useEffect(() => {
    if (queryInput === filter.q) return;
    const timer = setTimeout(() => {
      setFilter((current) => ({ ...current, q: queryInput }));
      setPage(1);
    }, 280);
    return () => clearTimeout(timer);
  }, [filter.q, queryInput]);

  const params = useMemo(() => slocFilterParams(filter), [filter]);

  // Facet punya siklus hidup sendiri. Sebelumnya ia menumpang permintaan tabel
  // yang pertama, sehingga satu pembatalan saja — hal biasa saat React memasang
  // komponen dua kali, atau saat pengguna mengetik sebelum muatan awal selesai —
  // membuat dropdown gudang dan zona kosong selamanya.
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/sloc/facets", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Facets failed"))))
      .then((data) => {
        if (!data?.error) setFacets(data as SlocFacets);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const search = new URLSearchParams(params);
    search.set("offset", String((page - 1) * pageSize));
    search.set("limit", String(pageSize));
    setLoading(true);
    setError(false);
    fetch(`/api/sloc/explore?${search}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("SLOC explore request failed");
        return response.json();
      })
      .then((data) => {
        setRows((data.rows ?? []) as SlocExplorerRow[]);
        setSummary((data.summary ?? EMPTY_SUMMARY) as SlocExplorerSummary);
      })
      .catch((requestError) => {
        if (requestError?.name === "AbortError") return;
        setError(true);
        setRows([]);
        setSummary(EMPTY_SUMMARY);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, pageSize, params]);

  // URL disamakan tanpa navigasi: menyalin alamat halaman harus cukup untuk
  // membagikan tampilan yang sama kepada rekan kerja.
  useEffect(() => {
    if (!syncUrl || typeof window === "undefined") return;
    const search = params.toString();
    const next = `${window.location.pathname}${search ? `?${search}` : ""}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, "", next);
    }
  }, [params, syncUrl]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setStockLoading(true);
    setStock([]);
    fetch(
      `/api/sloc?code=${encodeURIComponent(selected.sloc_code)}&wh=${encodeURIComponent(selected.wh)}`,
      { signal: controller.signal },
    )
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("SLOC detail failed"))))
      .then((data) => setStock((data.stock ?? []) as StockLine[]))
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setStockLoading(false);
      });
    return () => controller.abort();
  }, [selected]);

  // Halaman di belakang panel tidak boleh ikut bergulir: pada layar sentuh,
  // menggulir isi panel sampai mentok memindahkan tabel di belakangnya, dan
  // posisi baca hilang begitu panel ditutup.
  useEffect(() => {
    if (!selected) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [selected]);

  const patch = useCallback((next: Partial<SlocFilter>) => {
    setFilter((current) => ({ ...current, ...next }));
    setPage(1);
  }, []);

  const toggleStatus = useCallback((status: SlocStatusFilter) => {
    setFilter((current) => ({
      ...current,
      status: current.status.includes(status)
        ? current.status.filter((value) => value !== status)
        : [...current.status, status],
    }));
    setPage(1);
  }, []);

  const applyPreset = useCallback((preset: (typeof PRESETS)[number]) => {
    setFilter((current) => ({ ...current, ...preset.patch }));
    setPage(1);
  }, []);

  const reset = useCallback(() => {
    setQueryInput("");
    setFilter((current) => ({
      ...EMPTY_SLOC_FILTER,
      view: current.view,
      sort: current.sort,
      dir: current.dir,
      wh: lockedWh ?? "",
      zone: lockedZone ?? "",
    }));
    setPage(1);
  }, [lockedWh, lockedZone]);

  const warehouses = facets?.warehouses ?? [];
  const zoneOptions = useMemo(
    () => (facets?.zones ?? []).filter((zone) => !filter.wh || zone.wh === filter.wh),
    [facets, filter.wh],
  );
  const rackZoneOptions = useMemo(() => {
    const source = zoneOptions.filter((zone) => !filter.zone || zone.zone === filter.zone);
    return [...new Set(source.flatMap((zone) => zone.rack_zones))].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }));
  }, [filter.zone, zoneOptions]);

  const totalPages = Math.max(1, Math.ceil(summary.total / pageSize));
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const changePageSize = (size: number) => {
    setPageSize(size);
    setPage(1);
    if (storageKey && typeof window !== "undefined") {
      window.localStorage.setItem(`wiom.slocx.size.${storageKey}`, String(size));
    }
  };

  const toggleSort = (key: SlocSort, initial: "asc" | "desc" = "desc") => {
    setFilter((current) => ({
      ...current,
      sort: key,
      dir: current.sort === key ? (current.dir === "asc" ? "desc" : "asc") : initial,
    }));
    setPage(1);
  };
  const head = (label: string, key: SlocSort, className = "", initial: "asc" | "desc" = "desc") => (
    <th
      className={className}
      scope="col"
      aria-sort={filter.sort === key ? (filter.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button type="button" className="occ-sort" onClick={() => toggleSort(key, initial)}>
        {label}
        <span aria-hidden>{filter.sort === key ? (filter.dir === "asc" ? "↑" : "↓") : "↕"}</span>
      </button>
    </th>
  );

  const statusOptions: SlocStatusFilter[] =
    filter.view === "bin" ? [] : [...LADDER_STATUSES, "UNAVAILABLE"];
  const activeCount = activeSlocFilterCount(filter);
  const pctText = (value: number | null) => (value === null ? "—" : `${value}%`);
  const openRow = (row: SlocExplorerRow) => {
    drawerTrigger.current = document.activeElement as HTMLElement | null;
    setSelected(row);
  };
  const closeRow = () => {
    setSelected(null);
    requestAnimationFrame(() => drawerTrigger.current?.focus());
  };

  return (
    <div className="slocx" aria-busy={loading}>
      <div className="slocx-toolbar">
        <label className="slocx-search">
          <span className="sr-only">{t("slocx.searchLabel")}</span>
          <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input
            className="input"
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            placeholder={t("slocx.searchPlaceholder")}
            autoComplete="off"
            spellCheck={false}
          />
          {queryInput && (
            <button type="button" className="slocx-search-clear" onClick={() => setQueryInput("")}
              aria-label={t("action.reset")}>×</button>
          )}
        </label>

        {!lockedWh && (
          <label className="slocx-select">
            <span className="sr-only">{t("common.warehouse")}</span>
            <select className="input" value={filter.wh}
              onChange={(event) => patch({ wh: event.target.value, zone: "", rackZone: "" })}>
              <option value="">{t("common.allWarehouses")}</option>
              {warehouses.map((warehouse) => (
                <option key={warehouse.code} value={warehouse.code}>
                  {warehouse.code} · {warehouse.sloc_total.toLocaleString(locale)}
                </option>
              ))}
            </select>
          </label>
        )}

        {!lockedZone && (
          <label className="slocx-select">
            <span className="sr-only">{t("common.zone")}</span>
            <select className="input" value={filter.zone}
              onChange={(event) => patch({ zone: event.target.value, rackZone: "" })}>
              <option value="">{t("slocx.allZones")}</option>
              {zoneOptions.map((zone) => (
                <option key={`${zone.wh}-${zone.zone}`} value={zone.zone}>
                  {filter.wh ? zone.zone : `${zone.wh} · ${zone.zone}`}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="slocx-select">
          <span className="sr-only">{t("export.fill")}</span>
          <select className="input" value={filter.fill}
            onChange={(event) => patch({ fill: event.target.value as FillMode })}>
            <option value="all">{t("export.fill.all")}</option>
            <option value="empty">{t("export.fill.empty")}</option>
            <option value="occupied">{t("export.fill.occupied")}</option>
          </select>
        </label>

        <label className="slocx-select">
          <span className="sr-only">{t("basis.label")}</span>
          <select className="input" value={filter.view}
            onChange={(event) => patch({ view: event.target.value as BasisMode, status: [] })}>
            {(["policy", "qty", "cbm", "bin"] as BasisMode[]).map((mode) => (
              <option key={mode} value={mode}>{t(`basis.${mode}`)}</option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className={`btn btn-sm slocx-more${showAdvanced ? " is-active" : ""}`}
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((value) => !value)}
        >
          {t("slocx.moreFilters")}
          {activeCount > 0 && <span className="slocx-badge num">{activeCount}</span>}
        </button>

        <ExportExcelButton dataset="sloc" params={params} variant="primary"
          disabled={loading || summary.total === 0}
          label={`${t("export.excel")} (${summary.total.toLocaleString(locale)})`}
          title={t("export.fullHint")} />
      </div>

      {showAdvanced && (
        <div className="slocx-advanced">
          <label>
            <span>{t("export.rackZone")}</span>
            <select className="input" value={filter.rackZone}
              onChange={(event) => patch({ rackZone: event.target.value })}>
              <option value="">{t("common.all")}</option>
              {rackZoneOptions.map((rackZone) => (
                <option key={rackZone} value={rackZone}>{rackZone}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("common.storage")}</span>
            <select className="input" value={filter.storage}
              onChange={(event) => patch({ storage: event.target.value })}>
              <option value="">{t("common.all")}</option>
              {(facets?.storages ?? []).map((storage) => (
                <option key={storage} value={storage}>{storage}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("slocx.minPct")}</span>
            <input className="input" type="number" min={0} max={1000} step={1} inputMode="numeric"
              value={filter.minPct ?? ""}
              onChange={(event) => patch({
                minPct: event.target.value === "" ? null : Number(event.target.value),
              })} />
          </label>
          <label>
            <span>{t("slocx.maxPct")}</span>
            <input className="input" type="number" min={0} max={1000} step={1} inputMode="numeric"
              value={filter.maxPct ?? ""}
              onChange={(event) => patch({
                maxPct: event.target.value === "" ? null : Number(event.target.value),
              })} />
          </label>
          <div className="slocx-presets">
            <span>{t("slocx.presets")}</span>
            <div>
              {PRESETS.map((preset) => (
                <button key={preset.id} type="button" className="chip"
                  onClick={() => applyPreset(preset)}>{t(preset.labelKey)}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {statusOptions.length > 0 && (
        <div className="slocx-status-row" role="group" aria-label={t("heat.filterStatus")}>
          <button
            type="button"
            className={`chip${filter.status.length === 0 ? " chip-accent" : ""}`}
            onClick={() => patch({ status: [] })}
          >
            {t("heat.allStatuses")} <b className="num">{summary.total.toLocaleString(locale)}</b>
          </button>
          {statusOptions.map((status) => (
            <button
              key={status}
              type="button"
              className={`chip${filter.status.includes(status) ? " chip-accent" : ""}`}
              aria-pressed={filter.status.includes(status)}
              onClick={() => toggleStatus(status)}
            >
              {t(`heat.legendStatus.${status}`)}
              <b className="num">{(summary.by_status[status] ?? 0).toLocaleString(locale)}</b>
            </button>
          ))}
        </div>
      )}

      <div className="slocx-summary">
        <span><i>{t("occ.activeSloc")}</i><b className="num">{summary.total.toLocaleString(locale)}</b></span>
        <span><i>{t("occ.slocOccupied")}</i><b className="num">{summary.occupied.toLocaleString(locale)}</b></span>
        <span className="slocx-summary-empty">
          <i>{t("occ.emptySloc")}</i><b className="num">{summary.empty.toLocaleString(locale)}</b>
        </span>
        <span><i>Qty</i><b className="num">{f.num(summary.occ_qty)} / {f.num(summary.cap_qty)}</b></span>
        <span title={t("heat.capCbmHint")}>
          <i>{t("heat.cbmEffective")}</i>
          <b className="num">{f.cbm(summary.occ_cbm)} / {f.cbm(summary.cap_cbm)}</b>
        </span>
        <span><i>{t("common.sku")}</i><b className="num">{summary.sku_count.toLocaleString(locale)}</b></span>
        {!isDefaultSlocFilter(filter) && (
          <button type="button" className="btn btn-ghost btn-sm slocx-reset" onClick={reset}>
            {t("action.reset")}
          </button>
        )}
      </div>

      {error ? (
        <div className="occ-empty-state">{t("heat.loadError")}</div>
      ) : (
        <>
          <div className="slocx-table-wrap">
            <table className="tbl slocx-table">
              <thead>
                <tr>
                  {head(t("common.sloc"), "sloc_code", "", "asc")}
                  {!lockedWh && head(t("common.warehouse"), "wh", "", "asc")}
                  {!lockedZone && head(t("common.zone"), "zone", "", "asc")}
                  {head(t("export.rackZone"), "rack_zone", "", "asc")}
                  <th scope="col">{t("slocx.position")}</th>
                  {head(t("common.storage"), "storage", "", "asc")}
                  <th scope="col">{t("common.status")}</th>
                  {head(t("export.occQty"), "occ_qty", "text-right")}
                  {head(t("export.occCbm"), "occ_cbm", "text-right")}
                  {head("% Qty", "pct_qty", "text-right")}
                  {head("% CBM", "pct_cbm", "text-right")}
                  {head("% Bin", "pct_bin", "text-right")}
                  {head(t("dens.skuCount"), "sku_count", "text-right")}
                  {head(t("common.occupancy"), "pct", "text-right")}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  // Lihat catatan yang sama di movement-explorer: yang dapat
                  // difokus adalah tombol di sel pertama, bukan barisnya.
                  <tr
                    key={`${row.wh}-${row.sloc_code}`}
                    className="row-link"
                    onClick={() => openRow(row)}
                  >
                    <td className="num font-semibold">
                      <button
                        type="button"
                        className="row-open"
                        aria-haspopup="dialog"
                        aria-label={`${t("slocx.detail")}: ${row.sloc_code}`}
                        onClick={(event) => { event.stopPropagation(); openRow(row); }}
                      >
                        {row.sloc_code}
                      </button>
                    </td>
                    {!lockedWh && <td className="num">{row.wh}</td>}
                    {!lockedZone && <td>{row.zone}</td>}
                    <td className="num">{row.rack_zone || "—"}</td>
                    <td className="num text-[11px]">
                      {row.aisle || "—"}/{row.bay || "—"}/{row.level || "—"}/{row.bin || "—"}
                    </td>
                    <td className="max-w-[170px] truncate text-[11px]" title={row.storage}>
                      {row.storage || "—"}
                    </td>
                    <td>
                      {row.status === "OCCUPIED" || row.status === "EMPTY" || row.status === "UNAVAILABLE"
                        ? <span className={statusTone(row.status)}>{t(`heat.legendStatus.${row.status}`)}</span>
                        : <StatusBadge status={row.status as never} />}
                    </td>
                    <td className="num text-right">
                      {f.num(row.occ_qty)}
                      <span style={{ color: "var(--text-muted)" }}>/{row.qty_valid ? f.num(row.cap_qty) : "—"}</span>
                    </td>
                    <td className="num text-right">
                      {f.cbm(row.occ_cbm)}
                      <span style={{ color: "var(--text-muted)" }}>/{row.cbm_valid ? f.cbm(row.cap_cbm) : "—"}</span>
                    </td>
                    <td className="num text-right">{pctText(row.pct_qty)}</td>
                    <td className="num text-right">{pctText(row.pct_cbm)}</td>
                    <td className="num text-right">{row.pct_bin}%</td>
                    <td className="num text-right">{row.sku_count}</td>
                    {/* Warna angka mengikuti status baris ini, bukan ambang
                        tetap 90/100. Ambang berbeda per gudang, jadi versi lama
                        bisa memberi angka warna oranye pada baris yang
                        lencananya masih Warning. */}
                    <td className="num text-right font-semibold" style={{ color: rowColor(row) }}>
                      {pctText(row.view_pct)}
                    </td>
                  </tr>
                ))}
                {!loading && rows.length === 0 && (
                  <tr>
                    <td colSpan={14} className="py-10 text-center text-xs" style={{ color: "var(--text-muted)" }}>
                      {t("slocx.noMatches")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="slocx-mobile">
            {rows.map((row) => (
              <button key={`${row.wh}-${row.sloc_code}-mobile`} type="button"
                className="slocx-mobile-card" onClick={() => openRow(row)}>
                <div className="slocx-mobile-head">
                  <span>
                    <strong className="num">{row.sloc_code}</strong>
                    <small>{row.wh} · {row.zone} · {row.rack_zone || "—"}</small>
                  </span>
                  <strong className="num" style={{ color: rowColor(row) }}>
                    {pctText(row.view_pct)}
                  </strong>
                </div>
                <div className="slocx-mobile-metrics">
                  <span>{t("common.status")} <b>{t(`heat.legendStatus.${row.status}`)}</b></span>
                  <span>Qty <b className="num">{pctText(row.pct_qty)}</b></span>
                  <span>CBM <b className="num">{pctText(row.pct_cbm)}</b></span>
                  <span>SKU <b className="num">{row.sku_count}</b></span>
                </div>
              </button>
            ))}
            {!loading && rows.length === 0 && <div className="occ-empty-state">{t("slocx.noMatches")}</div>}
          </div>
        </>
      )}

      <div className="slocx-paging">
        <span className="num" aria-live="polite">
          {summary.total === 0
            ? t("slocx.noRows")
            : `${((page - 1) * pageSize + 1).toLocaleString(locale)}–${Math.min(page * pageSize, summary.total).toLocaleString(locale)} / ${summary.total.toLocaleString(locale)}`}
        </span>
        <label className="slocx-page-size">
          <span className="sr-only">{t("occ.rows")}</span>
          <select className="input" value={pageSize}
            onChange={(event) => changePageSize(Number(event.target.value))}>
            {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <button type="button" className="btn btn-sm" disabled={page <= 1 || loading}
          onClick={() => setPage((value) => value - 1)} aria-label={t("action.back")}>←</button>
        <span className="num">{page}/{totalPages}</span>
        <button type="button" className="btn btn-sm" disabled={page >= totalPages || loading}
          onClick={() => setPage((value) => value + 1)} aria-label={`${t("occ.rows")} ${page + 1}`}>→</button>
        {loading && <span className="slocx-loading">{t("common.loading")}</span>}
      </div>

      {selected && (
        <div className="heat-detail-backdrop"
          onMouseDown={(event) => { if (event.currentTarget === event.target) closeRow(); }}>
          <aside
            className="heat-detail-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="slocx-detail-title"
            onKeyDown={(event) => {
              trapFocus(event);
              if (event.key === "Escape") closeRow();
            }}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="eyebrow">{selected.wh} · {selected.zone} · {selected.rack_zone || "—"}</div>
                <h3 id="slocx-detail-title" className="num text-lg font-semibold">{selected.sloc_code}</h3>
              </div>
              <button type="button" autoFocus className="btn btn-ghost btn-sm" onClick={closeRow}>
                {t("action.close")}
              </button>
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="chip">{t(`heat.legendStatus.${selected.status}`)}</span>
              <span className="chip">{t(`basis.${filter.view}`)} {pctText(selected.view_pct)}</span>
              <span className="chip">{selected.occupied ? t("common.filled") : t("common.empty")}</span>
              <Link className="chip chip-accent"
                href={`/heatmap?wh=${selected.wh}&sloc=${encodeURIComponent(selected.sloc_code)}`}>
                {t("heat.title")} →
              </Link>
            </div>
            {/* Penyebut CBM adalah kapasitas efektif (max_cbm x utilisasi).
                Nilai konfigurasinya ikut ditampilkan supaya angka di layar
                dapat dicocokkan langsung dengan halaman Pengaturan. */}
            <div className="occ-basis-strip card mb-3">
              <div>
                <span className="eyebrow">Qty</span>
                <strong className="num">{pctText(selected.pct_qty)}</strong>
                <small>{f.num(selected.occ_qty)} / {selected.qty_valid ? f.num(selected.cap_qty) : "—"}</small>
              </div>
              <div>
                <span className="eyebrow">{t("heat.cbmEffective")}</span>
                <strong className="num">{pctText(selected.pct_cbm)}</strong>
                <small>{f.cbm(selected.occ_cbm)} / {selected.cbm_valid ? f.cbm(selected.cap_cbm) : "—"}</small>
                <small className="metric-formula num" title={t("heat.capCbmHint")}>
                  {selected.cbm_valid
                    ? `${t("heat.capConfigured")} ${f.capCbm(selected.cap_cbm_nominal)} × ${selected.utilization_pct}%`
                    : t("heat.capUnknown")}
                </small>
              </div>
              <div>
                <span className="eyebrow">Bin</span>
                <strong className="num">{selected.pct_bin}%</strong>
                <small>{selected.occupied ? t("heat.binFilled") : t("heat.binEmpty")}</small>
              </div>
            </div>
            <div className="eyebrow mb-1.5">{t("heat.skuAtLocation")} · {selected.sku_count} SKU</div>
            {stockLoading ? (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>{t("common.loading")}</p>
            ) : stock.length === 0 ? (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>{t("heat.noStock")}</p>
            ) : (
              <ul className="space-y-1.5">
                {stock.map((line, index) => (
                  <li key={`${line.product_id}-${index}`} className="card anim-in px-3 py-2 text-[11.5px]">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 font-semibold">{line.product_name}</span>
                      <span className="num shrink-0">{f.num(line.qty)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2" style={{ color: "var(--text-muted)" }}>
                      <span className="num">{t("common.skuNo")} {line.sku_number}</span>
                      <span className="num">{f.cbm(line.cbm)} m³</span>
                    </div>
                    <div className="flex items-center justify-between gap-2" style={{ color: "var(--text-muted)" }}>
                      <span className="truncate">{line.l1_category || "—"}</span>
                      {line.status !== "Available" && <span className="chip">{line.status}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
