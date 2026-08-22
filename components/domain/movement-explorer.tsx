"use client";
// Penjelajah pergerakan stok ("Recent movements").
//
// MENGAPA BUKAN TABEL 10 BARIS LAGI
// ---------------------------------
// Versi sebelumnya hanya menampilkan sepuluh baris terakhir per gudang, tanpa
// filter, tanpa jumlah, dan dengan tipe aksi apa adanya dari WMS. Pertanyaan
// yang benar-benar ditanyakan operasional — "apa yang keluar dari CBT semalam",
// "siapa yang memindahkan SKU ini", "kenapa stok rak ini turun" — tak satu pun
// dapat dijawab olehnya.
//
// Seluruh penyaringan dan penjumlahan dikerjakan di server memakai kontrak
// lib/movements.ts yang sama dengan SQL-nya, sehingga angka pada kartu KPI,
// batang aktivitas, tabel, dan berkas Excel selalu berasal dari satu himpunan
// baris yang sama persis.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  EMPTY_MOVEMENT_FILTER,
  EMPTY_MOVEMENT_SUMMARY,
  MOVEMENT_RANGES,
  MOVEMENT_TYPES,
  activeMovementFilterCount,
  isDefaultMovementFilter,
  movementFilterParams,
  type MovementBucket,
  type MovementDirection,
  type MovementFacets,
  type MovementFilter,
  type MovementRange,
  type MovementRow,
  type MovementSort,
  type MovementSummary,
  type MovementType,
  type MovementWarehouseRow,
} from "@/lib/movements";
import { formatters } from "@/lib/utils";
import { trapFocus } from "@/lib/focus-trap";
import { useT } from "@/lib/i18n-client";
import ExportExcelButton from "@/components/domain/export-excel-button";

const PAGE_SIZES = [25, 50, 100, 200];

/**
 * Warna tipe aksi mengikuti AKIBATNYA pada stok, bukan abjad: penambahan hijau,
 * pengurangan oranye, perpindahan internal biru, koreksi/status abu. Operator
 * gudang membaca kolom ini sambil lalu — warnanya harus berarti sesuatu.
 */
const TYPE_TONE: Record<MovementType, "in" | "out" | "move" | "control"> = {
  PURCHASE_ORDER: "in",
  PUTAWAY: "in",
  REPLENISHMENT: "move",
  SUPPLY_ORDER: "out",
  TRANSFER: "move",
  ADJUSTMENT: "control",
  CANCELLATION: "control",
  RETURN: "control",
  STATUS_CHANGE: "control",
  OTHER: "control",
};

/** Preset satu klik untuk pertanyaan yang paling sering diajukan. */
const PRESETS: Array<{ id: string; labelKey: string; patch: Partial<MovementFilter> }> = [
  { id: "inbound", labelKey: "mv.preset.inbound", patch: { type: ["PURCHASE_ORDER", "PUTAWAY"], direction: "", flow: "" } },
  { id: "outbound", labelKey: "mv.preset.outbound", patch: { type: ["SUPPLY_ORDER"], direction: "", flow: "" } },
  { id: "internal", labelKey: "mv.preset.internal", patch: { type: ["TRANSFER", "REPLENISHMENT"], direction: "", flow: "" } },
  { id: "control", labelKey: "mv.preset.control", patch: { type: ["ADJUSTMENT", "CANCELLATION", "STATUS_CHANGE"], direction: "", flow: "" } },
];

export default function MovementExplorer({
  lockedWh,
  storageKey,
  syncUrl = false,
  initialFilter,
}: {
  /** Halaman gudang mengunci cakupannya agar filter tidak keluar konteks. */
  lockedWh?: string;
  storageKey?: string;
  syncUrl?: boolean;
  initialFilter?: Partial<MovementFilter>;
}) {
  const { t, lang } = useT();
  const f = formatters(lang);
  const locale = f.locale;

  const [filter, setFilter] = useState<MovementFilter>(() => ({
    ...EMPTY_MOVEMENT_FILTER,
    ...initialFilter,
    ...(lockedWh ? { wh: lockedWh } : {}),
  }));
  const [queryInput, setQueryInput] = useState(filter.q);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [rows, setRows] = useState<MovementRow[]>([]);
  const [summary, setSummary] = useState<MovementSummary>(EMPTY_MOVEMENT_SUMMARY);
  const [activity, setActivity] = useState<MovementBucket[]>([]);
  const [warehouses, setWarehouses] = useState<MovementWarehouseRow[]>([]);
  const [facets, setFacets] = useState<MovementFacets | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selected, setSelected] = useState<MovementRow | null>(null);
  const drawerTrigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;
    const stored = Number(window.localStorage.getItem(`wiom.mvx.size.${storageKey}`));
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

  const params = useMemo(() => movementFilterParams(filter), [filter]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/movements/facets", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Facets failed"))))
      .then((data) => { if (!data?.error) setFacets(data as MovementFacets); })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const search = new URLSearchParams(params);
    search.set("offset", String((page - 1) * pageSize));
    search.set("limit", String(pageSize));
    // Strip per gudang tidak berarti apa-apa saat cakupannya sudah satu gudang.
    search.set("include", lockedWh ? "activity" : "activity,warehouses");
    setLoading(true);
    setError(false);
    fetch(`/api/movements?${search}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Movement request failed");
        return response.json();
      })
      .then((data) => {
        setRows((data.rows ?? []) as MovementRow[]);
        setSummary((data.summary ?? EMPTY_MOVEMENT_SUMMARY) as MovementSummary);
        setActivity((data.activity ?? []) as MovementBucket[]);
        setWarehouses((data.warehouses ?? []) as MovementWarehouseRow[]);
      })
      .catch((requestError) => {
        if (requestError?.name === "AbortError") return;
        setError(true);
        setRows([]);
        setSummary(EMPTY_MOVEMENT_SUMMARY);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [lockedWh, page, pageSize, params]);

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
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [selected]);

  const patch = useCallback((next: Partial<MovementFilter>) => {
    setFilter((current) => ({ ...current, ...next }));
    setPage(1);
  }, []);

  const toggleType = useCallback((type: MovementType) => {
    setFilter((current) => ({
      ...current,
      type: current.type.includes(type)
        ? current.type.filter((value) => value !== type)
        : [...current.type, type],
    }));
    setPage(1);
  }, []);

  const reset = useCallback(() => {
    setQueryInput("");
    setFilter((current) => ({
      ...EMPTY_MOVEMENT_FILTER,
      range: current.range,
      sort: current.sort,
      dir: current.dir,
      wh: lockedWh ?? "",
    }));
    setPage(1);
  }, [lockedWh]);

  const totalPages = Math.max(1, Math.ceil(summary.events / pageSize));
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const changePageSize = (size: number) => {
    setPageSize(size);
    setPage(1);
    if (storageKey && typeof window !== "undefined") {
      window.localStorage.setItem(`wiom.mvx.size.${storageKey}`, String(size));
    }
  };

  const toggleSort = (key: MovementSort, initial: "asc" | "desc" = "desc") => {
    setFilter((current) => ({
      ...current,
      sort: key,
      dir: current.sort === key ? (current.dir === "asc" ? "desc" : "asc") : initial,
    }));
    setPage(1);
  };
  const head = (label: string, key: MovementSort, className = "", initial: "asc" | "desc" = "desc") => (
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

  const activeCount = activeMovementFilterCount(filter);
  const openRow = (row: MovementRow) => {
    drawerTrigger.current = document.activeElement as HTMLElement | null;
    setSelected(row);
  };
  const closeRow = () => {
    setSelected(null);
    requestAnimationFrame(() => drawerTrigger.current?.focus());
  };

  const relative = useCallback((iso: string | null) => relativeTime(iso, locale), [locale]);
  const signed = (row: MovementRow) =>
    `${row.direction === "OUT" ? "−" : row.direction === "IN" ? "+" : ""}${f.num(row.qty)}`;

  const typeLabel = (type: MovementType) => t(`mv.type.${type}`);
  const columnCount = lockedWh ? 8 : 9;

  return (
    <div className="mvx" aria-busy={loading}>
      <div className="slocx-toolbar">
        <label className="slocx-search">
          <span className="sr-only">{t("mv.searchLabel")}</span>
          <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input
            className="input"
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            placeholder={t("mv.searchPlaceholder")}
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
              onChange={(event) => patch({ wh: event.target.value })}>
              <option value="">{t("common.allWarehouses")}</option>
              {(facets?.warehouses ?? []).map((warehouse) => (
                <option key={warehouse.code} value={warehouse.code}>
                  {warehouse.code} · {warehouse.events.toLocaleString(locale)}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="slocx-select">
          <span className="sr-only">{t("mv.range")}</span>
          <select className="input" value={filter.range}
            onChange={(event) => patch({ range: event.target.value as MovementRange })}>
            {MOVEMENT_RANGES.map((range) => (
              <option key={range} value={range}>{t(`mv.range.${range}`)}</option>
            ))}
          </select>
        </label>

        <label className="slocx-select">
          <span className="sr-only">{t("mv.direction")}</span>
          <select className="input" value={filter.direction}
            onChange={(event) => patch({ direction: event.target.value as MovementDirection | "" })}>
            <option value="">{t("mv.direction.all")}</option>
            <option value="IN">{t("mv.direction.IN")}</option>
            <option value="OUT">{t("mv.direction.OUT")}</option>
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

        <ExportExcelButton dataset="movements" params={params} variant="primary"
          disabled={loading || summary.events === 0}
          label={`${t("export.excel")} (${summary.events.toLocaleString(locale)})`}
          title={t("export.fullHint")} />
      </div>

      {showAdvanced && (
        <div className="slocx-advanced">
          <label>
            <span>{t("common.sloc")}</span>
            <input className="input" value={filter.sloc} placeholder={t("mv.slocPlaceholder")}
              onChange={(event) => patch({ sloc: event.target.value.toUpperCase() })} />
          </label>
          <label>
            <span>{t("mv.col.category")}</span>
            <select className="input" value={filter.category}
              onChange={(event) => patch({ category: event.target.value })}>
              <option value="">{t("common.all")}</option>
              {(facets?.categories ?? []).map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("mv.col.productType")}</span>
            <select className="input" value={filter.productType}
              onChange={(event) => patch({ productType: event.target.value })}>
              <option value="">{t("common.all")}</option>
              {(facets?.product_types ?? []).map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("mv.col.toStatus")}</span>
            <select className="input" value={filter.status}
              onChange={(event) => patch({ status: event.target.value })}>
              <option value="">{t("common.all")}</option>
              {(facets?.statuses ?? []).map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("common.operator")}</span>
            <select className="input" value={filter.operator}
              onChange={(event) => patch({ operator: event.target.value })}>
              <option value="">{t("common.all")}</option>
              {(facets?.operators ?? []).map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("mv.flow")}</span>
            <select className="input" value={filter.flow}
              onChange={(event) => patch({ flow: event.target.value as MovementFilter["flow"] })}>
              <option value="">{t("common.all")}</option>
              <option value="INBOUND">{t("mv.flow.INBOUND")}</option>
              <option value="INTERNAL">{t("mv.flow.INTERNAL")}</option>
              <option value="OUTBOUND">{t("mv.flow.OUTBOUND")}</option>
              <option value="IN_PLACE">{t("mv.flow.IN_PLACE")}</option>
            </select>
          </label>
          <div className="slocx-presets">
            <span>{t("slocx.presets")}</span>
            <div>
              {PRESETS.map((preset) => (
                <button key={preset.id} type="button" className="chip"
                  onClick={() => patch(preset.patch)}>{t(preset.labelKey)}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="slocx-status-row" role="group" aria-label={t("mv.filterType")}>
        <button
          type="button"
          className={`chip${filter.type.length === 0 ? " chip-accent" : ""}`}
          onClick={() => patch({ type: [] })}
        >
          {t("mv.allTypes")} <b className="num">{summary.events.toLocaleString(locale)}</b>
        </button>
        {MOVEMENT_TYPES.filter((type) => (summary.by_type[type] ?? 0) > 0 || filter.type.includes(type))
          .map((type) => (
            <button
              key={type}
              type="button"
              className={`chip mvx-type mvx-type-${TYPE_TONE[type]}${filter.type.includes(type) ? " is-on" : ""}`}
              aria-pressed={filter.type.includes(type)}
              onClick={() => toggleType(type)}
            >
              {typeLabel(type)}
              <b className="num">{(summary.by_type[type] ?? 0).toLocaleString(locale)}</b>
            </button>
          ))}
      </div>

      <div className="slocx-summary">
        <span><i>{t("mv.events")}</i><b className="num">{summary.events.toLocaleString(locale)}</b></span>
        <span className="mvx-in"><i>{t("mv.qtyIn")}</i><b className="num">+{f.num(summary.qty_in)}</b></span>
        <span className="mvx-out"><i>{t("mv.qtyOut")}</i><b className="num">−{f.num(summary.qty_out)}</b></span>
        <span><i>{t("mv.qtyNet")}</i>
          <b className="num" style={{ color: netColor(summary.qty_net) }}>
            {summary.qty_net > 0 ? "+" : ""}{f.num(summary.qty_net)}
          </b>
        </span>
        <span><i>{t("common.sku")}</i><b className="num">{summary.sku_count.toLocaleString(locale)}</b></span>
        <span><i>{t("mv.invoices")}</i><b className="num">{summary.invoice_count.toLocaleString(locale)}</b></span>
        <span><i>{t("mv.operators")}</i><b className="num">{summary.operator_count.toLocaleString(locale)}</b></span>
        <span><i>{t("mv.lastEvent")}</i><b className="num">{relative(summary.last_at)}</b></span>
        {!isDefaultMovementFilter(filter) && (
          <button type="button" className="btn btn-ghost btn-sm slocx-reset" onClick={reset}>
            {t("action.reset")}
          </button>
        )}
      </div>

      {activity.length > 1 && (
        <ActivityChart buckets={activity} label={t("mv.activity")} hint={t("mv.activityHint")}
          inLabel={t("mv.qtyIn")} outLabel={t("mv.qtyOut")} locale={locale} format={f.num} />
      )}

      {!lockedWh && warehouses.length > 0 && (
        <div className="mvx-wh-strip">
          <div className="eyebrow mvx-wh-title">{t("mv.perWarehouse")}</div>
          <div className="mvx-wh-grid">
            {warehouses.map((warehouse) => (
              <button
                key={warehouse.wh}
                type="button"
                className={`mvx-wh-card${filter.wh === warehouse.wh ? " is-on" : ""}`}
                aria-pressed={filter.wh === warehouse.wh}
                onClick={() => patch({ wh: filter.wh === warehouse.wh ? "" : warehouse.wh })}
                title={warehouse.name}
              >
                <div className="mvx-wh-head">
                  <strong className="num">{warehouse.wh}</strong>
                  <span className="num">{warehouse.events.toLocaleString(locale)}</span>
                </div>
                <div className="mvx-wh-flow">
                  <span className="mvx-in num">+{f.num(warehouse.qty_in)}</span>
                  <span className="mvx-out num">−{f.num(warehouse.qty_out)}</span>
                </div>
                <div className="mvx-wh-foot num">{relative(warehouse.last_at)}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {error ? (
        <div className="occ-empty-state">{t("heat.loadError")}</div>
      ) : !loading && summary.events === 0 && isDefaultMovementFilter(filter) ? (
        <div className="mvx-empty">
          <strong>{t("mv.empty.title")}</strong>
          <p>{t("mv.empty.body")}</p>
        </div>
      ) : (
        <>
          <div className="slocx-table-wrap">
            <table className="tbl mvx-table">
              <thead>
                <tr>
                  {head(t("common.time"), "at", "", "desc")}
                  {!lockedWh && head(t("common.warehouse"), "wh", "", "asc")}
                  {head(t("common.type"), "type", "", "asc")}
                  {head(t("common.product"), "product", "", "asc")}
                  <th scope="col">{t("mv.col.route")}</th>
                  <th scope="col">{t("mv.col.status")}</th>
                  {head("Qty", "qty", "text-right")}
                  {head(t("common.operator"), "operator", "", "asc")}
                  {head(t("mv.col.invoice"), "invoice", "", "asc")}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.movement_uid}
                    className="row-link"
                    tabIndex={0}
                    onClick={() => openRow(row)}
                    onKeyDown={(event) => event.key === "Enter" && openRow(row)}
                  >
                    <td className="num mvx-time">
                      <span>{f.dateTime(row.at)}</span>
                      <small>{relative(row.at)}</small>
                    </td>
                    {!lockedWh && <td className="num">{row.wh}</td>}
                    <td>
                      <span className={`chip mvx-type mvx-type-${TYPE_TONE[row.movement_type]}`}
                        title={row.action_raw}>
                        {typeLabel(row.movement_type)}
                      </span>
                    </td>
                    <td className="mvx-product">
                      <span title={row.product_name}>{row.product_name || "—"}</span>
                      <small className="num">{row.sku_number || "—"}</small>
                    </td>
                    <td className="num mvx-route">
                      <span title={row.source_sloc ?? "—"}>{row.source_sloc ?? "—"}</span>
                      <b aria-hidden>→</b>
                      <span title={row.destination_sloc ?? "—"}>{row.destination_sloc ?? "—"}</span>
                    </td>
                    <td className="mvx-status">
                      {row.from_status || row.to_status ? (
                        <span className="num">
                          {row.from_status ?? "—"}
                          {row.to_status && row.to_status !== row.from_status
                            ? ` → ${row.to_status}` : ""}
                        </span>
                      ) : "—"}
                    </td>
                    <td className={`num text-right mvx-qty mvx-${row.direction.toLowerCase()}`}>
                      {signed(row)}
                    </td>
                    <td className="mvx-operator" title={row.operator}>{row.operator || "—"}</td>
                    <td className="num mvx-invoice" title={row.invoice_number}>
                      {row.invoice_number || "—"}
                    </td>
                  </tr>
                ))}
                {!loading && rows.length === 0 && (
                  <tr>
                    <td colSpan={columnCount} className="py-10 text-center text-xs"
                      style={{ color: "var(--text-muted)" }}>
                      {t("mv.noMatches")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="slocx-mobile">
            {rows.map((row) => (
              <button key={`${row.movement_uid}-mobile`} type="button"
                className="slocx-mobile-card" onClick={() => openRow(row)}>
                <div className="slocx-mobile-head">
                  <span>
                    <strong>{row.product_name || "—"}</strong>
                    <small>{row.wh} · {row.sku_number || "—"} · {relative(row.at)}</small>
                  </span>
                  <strong className={`num mvx-qty mvx-${row.direction.toLowerCase()}`}>{signed(row)}</strong>
                </div>
                <div className="slocx-mobile-metrics">
                  <span className={`chip mvx-type mvx-type-${TYPE_TONE[row.movement_type]}`}>
                    {typeLabel(row.movement_type)}
                  </span>
                  <span className="num">{row.source_sloc ?? "—"} → {row.destination_sloc ?? "—"}</span>
                  <span>{row.operator || "—"}</span>
                </div>
              </button>
            ))}
            {!loading && rows.length === 0 && <div className="occ-empty-state">{t("mv.noMatches")}</div>}
          </div>
        </>
      )}

      <div className="slocx-paging">
        <span className="num" aria-live="polite">
          {summary.events === 0
            ? t("mv.noRows")
            : `${((page - 1) * pageSize + 1).toLocaleString(locale)}–${Math.min(page * pageSize, summary.events).toLocaleString(locale)} / ${summary.events.toLocaleString(locale)}`}
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
            aria-labelledby="mvx-detail-title"
            onKeyDown={(event) => {
              trapFocus(event);
              if (event.key === "Escape") closeRow();
            }}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="eyebrow">
                  {selected.wh} · {f.dateTime(selected.at)}
                </div>
                <h3 id="mvx-detail-title" className="text-base font-semibold">
                  {selected.product_name || "—"}
                </h3>
              </div>
              <button type="button" autoFocus className="btn btn-ghost btn-sm" onClick={closeRow}>
                {t("action.close")}
              </button>
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className={`chip mvx-type mvx-type-${TYPE_TONE[selected.movement_type]}`}>
                {typeLabel(selected.movement_type)}
              </span>
              <span className="chip">{t(`mv.direction.${selected.direction}`)}</span>
              <span className="chip">{t(`mv.flow.${selected.flow}`)}</span>
              <span className={`chip mvx-qty mvx-${selected.direction.toLowerCase()}`}>
                {signed(selected)} {t("common.unit")}
              </span>
            </div>

            {/* Rute lokasi ditampilkan sebagai satu baris besar: inilah yang
                paling sering dicari saat menelusuri kenapa isi sebuah rak
                berubah. */}
            <div className="mvx-route-card card mb-3">
              <div>
                <span className="eyebrow">{t("common.from")}</span>
                <strong className="num">{selected.source_sloc ?? "—"}</strong>
                <small className="num">{selected.from_package ?? "—"}</small>
                <small>{selected.from_status ?? "—"}</small>
              </div>
              <span className="mvx-route-arrow" aria-hidden>→</span>
              <div>
                <span className="eyebrow">{t("common.to")}</span>
                <strong className="num">{selected.destination_sloc ?? "—"}</strong>
                <small className="num">{selected.to_package ?? "—"}</small>
                <small>{selected.to_status ?? "—"}</small>
              </div>
            </div>

            <dl className="mvx-detail-grid">
              <Field label={t("mv.col.invoice")} value={selected.invoice_number} mono />
              <Field label={t("common.sku")} value={selected.sku_number} mono />
              <Field label={t("mv.col.productId")} value={selected.product_id} mono />
              <Field label={t("mv.col.category")} value={selected.l1_category} />
              <Field label={t("mv.col.productType")} value={selected.product_type} />
              <Field label={t("common.operator")} value={selected.operator} />
              <Field label={t("mv.col.locationName")} value={selected.location_name} />
              <Field label={t("mv.detail.rawAction")} value={selected.action_raw} mono />
              <Field label={t("mv.detail.created")} value={f.dateTime(selected.at)} mono />
              <Field label={t("mv.detail.updated")} value={f.dateTime(selected.updated_at)} mono />
            </dl>

            <div className="mt-3 flex flex-wrap gap-2">
              {selected.invoice_number && (
                <button type="button" className="chip chip-accent"
                  onClick={() => { patch({ q: selected.invoice_number }); setQueryInput(selected.invoice_number); closeRow(); }}>
                  {t("mv.filterByInvoice")}
                </button>
              )}
              {selected.operator && (
                <button type="button" className="chip"
                  onClick={() => { patch({ operator: selected.operator }); closeRow(); }}>
                  {t("mv.filterByOperator")}
                </button>
              )}
              {(selected.destination_sloc ?? selected.source_sloc) && (
                <Link className="chip"
                  href={`/heatmap?wh=${selected.wh}&sloc=${encodeURIComponent((selected.destination_sloc ?? selected.source_sloc) as string)}`}>
                  {t("heat.title")} →
                </Link>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: unknown; mono?: boolean }) {
  const text = value === null || value === undefined || value === "" ? "—" : String(value);
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className={mono ? "num" : undefined} title={text}>{text}</dd>
    </div>
  );
}

function netColor(net: number): string {
  if (net > 0) return "var(--st-normal-fg)";
  if (net < 0) return "var(--st-warning-fg)";
  return "var(--text)";
}

/**
 * Batang aktivitas masuk/keluar.
 *
 * Digambar sebagai SVG langsung, bukan lewat pustaka grafik: bentuknya tetap
 * (dua deret, satu sumbu nol) dan halaman ini sudah memuat tabel besar —
 * menambah runtime chart hanya untuk sepuluh batang adalah ongkos yang tidak
 * dibayar oleh apa pun.
 */
function ActivityChart({
  buckets, label, hint, inLabel, outLabel, locale, format,
}: {
  buckets: MovementBucket[];
  label: string; hint: string; inLabel: string; outLabel: string;
  locale: string;
  format: (value: number | null | undefined, digits?: number) => string;
}) {
  const peak = Math.max(1, ...buckets.map((b) => Math.max(b.qty_in, b.qty_out)));
  const width = 100;
  const slot = width / buckets.length;
  const barWidth = Math.max(0.6, slot * 0.62);
  const hourly = buckets.length > 1
    && new Date(buckets[1].t).getTime() - new Date(buckets[0].t).getTime() <= 3_600_000 * 1.5;
  const tick = (iso: string) => new Date(iso).toLocaleString(locale, hourly
    ? { hour: "2-digit", hourCycle: "h23", timeZone: "Asia/Jakarta" }
    : { day: "2-digit", month: "short", timeZone: "Asia/Jakarta" });

  return (
    <figure className="mvx-activity card">
      <figcaption>
        <span className="eyebrow">{label}</span>
        <span className="mvx-activity-legend">
          <i className="mvx-swatch-in" aria-hidden />{inLabel}
          <i className="mvx-swatch-out" aria-hidden />{outLabel}
          <small>{hint}</small>
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${width} 46`} preserveAspectRatio="none" role="img" aria-label={label}>
        <line x1="0" y1="23" x2={width} y2="23" stroke="var(--border-strong)" strokeWidth="0.25" />
        {buckets.map((bucket, index) => {
          const x = index * slot + (slot - barWidth) / 2;
          const inHeight = (bucket.qty_in / peak) * 20;
          const outHeight = (bucket.qty_out / peak) * 20;
          return (
            <g key={bucket.t}>
              <title>
                {`${tick(bucket.t)} · ${inLabel} ${format(bucket.qty_in)} · ${outLabel} ${format(bucket.qty_out)}`}
              </title>
              <rect x={x} y={23 - inHeight} width={barWidth} height={Math.max(0.4, inHeight)}
                fill="var(--st-normal-fg)" opacity="0.85" />
              <rect x={x} y={23} width={barWidth} height={Math.max(0.4, outHeight)}
                fill="var(--st-warning-fg)" opacity="0.85" />
            </g>
          );
        })}
      </svg>
      <div className="mvx-activity-axis num">
        <span>{tick(buckets[0].t)}</span>
        <span>{tick(buckets[buckets.length - 1].t)}</span>
      </div>
    </figure>
  );
}

/** "3 jam lalu" — jarak waktu yang dibaca lebih cepat daripada stempel penuh. */
function relativeTime(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "—";
  const seconds = Math.round((time - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["second", 60], ["minute", 60], ["hour", 24], ["day", 7], ["week", 4.35], ["month", 12],
  ];
  let value = seconds;
  for (const [unit, size] of units) {
    if (Math.abs(value) < size) return formatter.format(Math.round(value), unit);
    value /= size;
  }
  return formatter.format(Math.round(value), "year");
}
