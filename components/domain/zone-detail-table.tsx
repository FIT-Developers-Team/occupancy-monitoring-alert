"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ZoneDetailFacets, ZoneDetailSort, ZoneLine } from "@/lib/queries";
import { formatters } from "@/lib/utils";
import { useT } from "@/lib/i18n-client";
import ExportExcelButton from "@/components/domain/export-excel-button";

type SortKey = ZoneDetailSort;
type StockTone = "normal" | "monitor" | "warning" | "critical" | "breach";

const STOCK_STATUS_TONES: Array<{ matches: RegExp; tone: StockTone }> = [
  { matches: /^(available|unrestricted|good|released|usable)$/i, tone: "normal" },
  { matches: /(quality|inspection|hold|quarantine|restricted)/i, tone: "warning" },
  { matches: /(blocked|damaged|expired|bad|lost|scrap|destroy)/i, tone: "breach" },
];

function stockStatusTone(status: string): StockTone {
  const normalized = status.trim();
  return STOCK_STATUS_TONES.find(({ matches }) => matches.test(normalized))?.tone ?? "monitor";
}

export default function ZoneDetailTable({
  rows,
  total,
  warehouse,
  zone,
  statusColor,
  facets,
}: {
  rows: ZoneLine[];
  total: number;
  warehouse: string;
  zone: string;
  statusColor: Record<string, string>;
  /** Pilihan status stok / kategori / zona rak yang benar-benar ada di zona ini. */
  facets: ZoneDetailFacets;
}) {
  const { t, lang } = useT();
  const f = formatters(lang);
  const [serverRows, setServerRows] = useState(rows);
  const [totalRows, setTotalRows] = useState(total);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [stockStatus, setStockStatus] = useState("");
  const [category, setCategory] = useState("");
  const [rackZone, setRackZone] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({
    key: "sloc_code",
    dir: 1,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const skipInitialRequest = useRef(true);

  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));

  // Satu objek parameter dipakai tabel dan tombol ekspor. Kalau keduanya
  // menyusun kueri sendiri, berkas yang diunduh cepat atau lambat tidak lagi
  // sama dengan yang terlihat di layar.
  const filterParams = useMemo(() => {
    const params = new URLSearchParams({ wh: warehouse, zone });
    if (deferredQuery) params.set("q", deferredQuery);
    if (stockStatus) params.set("stockStatus", stockStatus);
    if (category) params.set("category", category);
    if (rackZone) params.set("rackZone", rackZone);
    return params;
  }, [category, deferredQuery, rackZone, stockStatus, warehouse, zone]);

  useEffect(() => {
    if (
      skipInitialRequest.current
      && page === 1
      && pageSize === 100
      && sort.key === "sloc_code"
      && sort.dir === 1
      && filterParams.toString() === new URLSearchParams({ wh: warehouse, zone }).toString()
    ) {
      skipInitialRequest.current = false;
      return;
    }
    skipInitialRequest.current = false;
    const controller = new AbortController();
    const params = new URLSearchParams(filterParams);
    params.set("offset", String((page - 1) * pageSize));
    params.set("limit", String(pageSize));
    params.set("sort", sort.key);
    params.set("dir", sort.dir === 1 ? "asc" : "desc");
    setLoading(true);
    setError(false);
    fetch(`/api/occupancy/zone-detail?${params}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Zone detail request failed");
        return response.json();
      })
      .then((data) => {
        setServerRows((data.rows ?? []) as ZoneLine[]);
        setTotalRows(Number(data.total ?? 0));
      })
      .catch((requestError) => {
        if (requestError?.name !== "AbortError") setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [filterParams, page, pageSize, sort, warehouse, zone]);

  useEffect(() => {
    setPage(1);
  }, [deferredQuery, stockStatus, category, rackZone]);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const toggleSort = (key: SortKey, initial: 1 | -1 = 1) => {
    setPage(1);
    setSort((current) => ({
      key,
      dir: current.key === key ? (current.dir * -1 as 1 | -1) : initial,
    }));
  };
  const head = (label: string, key: SortKey, className = "", initial: 1 | -1 = 1) => (
    <th
      className={className}
      scope="col"
      aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className="occ-sort"
        onClick={() => toggleSort(key, initial)}
        aria-label={`${label}, ${sort.key === key && sort.dir === 1 ? "descending" : "ascending"}`}
      >
        {label}
        <span aria-hidden>{sort.key === key ? (sort.dir === 1 ? "↑" : "↓") : "↕"}</span>
      </button>
    </th>
  );

  return (
    <div className="zone-detail-browser" aria-busy={loading}>
      <div className="zone-detail-toolbar">
        <label>
          <span className="sr-only">{t("action.search")}</span>
          <input
            className="input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`${t("action.search")} ${t("common.sloc")} / ${t("common.sku")}`}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="zone-detail-filters">
          {facets.rack_zones.length > 1 && (
            <label>
              <span className="sr-only">{t("export.rackZone")}</span>
              <select className="input" value={rackZone} onChange={(event) => setRackZone(event.target.value)}>
                <option value="">{t("zdx.allRackZones")}</option>
                {facets.rack_zones.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          )}
          <label>
            <span className="sr-only">{t("zdx.stockStatus")}</span>
            <select className="input" value={stockStatus} onChange={(event) => setStockStatus(event.target.value)}>
              <option value="">{t("zdx.allStatuses")}</option>
              {facets.statuses.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>
            <span className="sr-only">{t("zdx.category")}</span>
            <select className="input" value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">{t("zdx.allCategories")}</option>
              {facets.categories.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
        <div className="zone-detail-paging">
          <span className="num" aria-live="polite">
            {totalRows.toLocaleString()} {t("occ.rows")}
          </span>
          <select
            className="input"
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
            aria-label={`${t("occ.rows")} / ${t("common.total")}`}
          >
            {[50, 100, 200].map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
          <button
            type="button"
            className="btn btn-sm"
            disabled={page <= 1 || loading}
            onClick={() => setPage((value) => value - 1)}
            aria-label={`${t("action.back")} · ${t("occ.rows")}`}
          >←</button>
          <span className="num" aria-live="polite">{page}/{totalPages}</span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((value) => value + 1)}
            aria-label={`${t("occ.rows")} · ${page + 1}`}
          >→</button>
          <ExportExcelButton
            dataset="zone-detail"
            params={filterParams}
            disabled={totalRows === 0}
            label={`${t("export.excel")} (${totalRows.toLocaleString()})`}
            title={t("export.fullHint")}
          />
        </div>
      </div>

      {error && (
        <div className="occ-empty-state">
          {t("heat.loadError")}
        </div>
      )}

      {!error && (
        <div className="zone-detail-table-wrap">
          <table className="tbl">
            <thead><tr>
              {head(t("common.sloc"), "sloc_code")}
              {head(t("common.skuNo"), "sku_number")}
              {head(t("common.product"), "product_name")}
              <th scope="col">{t("common.category")}</th>
              <th scope="col">{t("common.status")}</th>
              {head("Qty", "qty", "text-right", -1)}
              {head("CBM", "cbm", "text-right", -1)}
              {head(t("common.occupancy"), "sloc_pct", "text-right", -1)}
            </tr></thead>
            <tbody>
              {serverRows.map((row, index) => (
                <tr key={`${row.sloc_code}-${row.sku_number}-${row.status}-${index}`}>
                  <td className="num">{row.sloc_code}</td>
                  <td className="num">{row.sku_number}</td>
                  <td className="max-w-[280px] truncate" title={row.product_name}>{row.product_name}</td>
                  <td className="text-[11px]">{row.l1_category || "—"}</td>
                  <td><span className={`badge badge-${stockStatusTone(row.status)}`}>{row.status || "—"}</span></td>
                  <td className="num text-right">{f.num(row.qty)}</td>
                  <td className="num text-right">{f.cbm(row.cbm)}</td>
                  <td
                    className="num text-right font-semibold"
                    style={{ color: statusColor[row.sloc_status] ?? "var(--text)" }}
                  >
                    {row.sloc_pct}%
                    <span className="text-[10px] font-normal" style={{ color: "var(--text-muted)" }}>
                      {" "}({row.sloc_basis})
                    </span>
                  </td>
                </tr>
              ))}
              {serverRows.length === 0 && !loading && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-xs" style={{ color: "var(--text-muted)" }}>
                    {t("common.none")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {!error && (
        <div className="zone-detail-mobile">
          {serverRows.map((row, index) => (
            <article
              key={`${row.sloc_code}-${row.sku_number}-${row.status}-mobile-${index}`}
              className="zone-detail-mobile-card"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className="eyebrow">{t("common.sloc")}</span>
                  <strong className="num block truncate">{row.sloc_code}</strong>
                </div>
                <div className="shrink-0 text-right">
                  <strong
                    className="num block"
                    style={{ color: statusColor[row.sloc_status] ?? "var(--text)" }}
                  >
                    {row.sloc_pct}%
                  </strong>
                  <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                    {row.sloc_basis.toUpperCase()}
                  </span>
                </div>
              </div>
              <div className="mt-2 truncate text-[12px] font-semibold" title={row.product_name}>
                {row.product_name || "—"}
              </div>
              <div className="num truncate text-[10.5px]" style={{ color: "var(--text-muted)" }}>
                {t("common.sku")} {row.sku_number || "—"} · {row.l1_category || "—"}
              </div>
              <div className="zone-detail-mobile-metrics">
                <span>Qty <b className="num">{f.num(row.qty)}</b></span>
                <span>CBM <b className="num">{f.cbm(row.cbm)}</b></span>
                <span className={`badge badge-${stockStatusTone(row.status)}`}>{row.status || "—"}</span>
              </div>
            </article>
          ))}
          {serverRows.length === 0 && !loading && <div className="occ-empty-state">{t("common.none")}</div>}
        </div>
      )}

      {loading && <div className="zone-detail-loading">{t("common.loading")}</div>}
    </div>
  );
}
