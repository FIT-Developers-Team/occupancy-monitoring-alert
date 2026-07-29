"use client";
// Tabel lokasi terpadat + drawer isi lokasi (No SKU sesuai data Superset).
import { useEffect, useMemo, useState } from "react";
import type { StockLine } from "@/types";
import { fmtNum, fmtCbm, statusLabel } from "@/lib/utils";
import { useT } from "@/lib/i18n-client";
import { StatusBadge } from "@/components/ui/badges";

export interface DenseRow {
  sloc_code: string; wh: string; zone: string; storage: string; basis: string;
  pct: number; status: string; occ_qty: number; cap_qty: number;
  occ_cbm: number; cap_cbm: number; sku_count: number;
  pct_qty: number | null; pct_cbm: number | null; pct_bin: number;
  qty_valid: boolean; cbm_valid: boolean;
}

type SortKey = "sloc_code" | "wh" | "zone" | "occ_qty" | "occ_cbm" | "pct_qty" | "pct_cbm" | "pct_bin" | "sku_count" | "pct";

export default function DensityTable({ rows }: { rows: DenseRow[] }) {
  const { t } = useT();
  const [sel, setSel] = useState<DenseRow | null>(null);
  const [stock, setStock] = useState<StockLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "pct", dir: -1 });
  const sortedRows = useMemo(() => [...rows].sort((a, b) => {
    const av = a[sort.key]; const bv = b[sort.key];
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sort.dir;
    return String(av ?? "").localeCompare(String(bv ?? ""), undefined, { numeric: true }) * sort.dir;
  }), [rows, sort]);
  const th = (label: string, key: SortKey, cls = "") => (
    <th
      className={cls}
      scope="col"
      aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
    ><button className="inline-flex items-center gap-1 hover:text-[var(--text)]"
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir * -1 as 1 | -1) : -1 }))}>
      {label}<span className="text-[10px]" style={{ color: "var(--text-muted)" }}>{sort.key === key ? (sort.dir === 1 ? "↑" : "↓") : "↕"}</span>
    </button></th>
  );

  useEffect(() => {
    if (!sel) return;
    setLoading(true); setStock([]);
    fetch(`/api/sloc?code=${encodeURIComponent(sel.sloc_code)}`)
      .then((r) => r.json())
      .then((j) => setStock(j.stock ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [sel]);

  return (
    <>
      <div className="density-table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              {th(t("common.sloc"), "sloc_code")}{th(t("common.warehouse"), "wh")}{th(t("common.zone"), "zone")}
              <th>{t("common.storage")}</th><th>{t("common.status")}</th>
              {th("Qty", "occ_qty", "text-right")}{th("CBM", "occ_cbm", "text-right")}
              {th("% Qty", "pct_qty", "text-right")}{th("% CBM", "pct_cbm", "text-right")}
              {th("% Bin", "pct_bin", "text-right")}{th(t("dens.skuCount"), "sku_count", "text-right")}
              {th(t("common.occupancy"), "pct", "text-right")}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r) => (
              <tr key={r.sloc_code} className="row-link" onClick={() => setSel(r)}
                tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setSel(r)}>
                <td className="num font-semibold">{r.sloc_code}</td>
                <td className="num">{r.wh}</td>
                <td>{r.zone}</td>
                <td className="max-w-[170px] truncate text-[11px]" title={r.storage}>{r.storage}</td>
                <td><StatusBadge status={r.status as never} /></td>
                <td className="num text-right">{fmtNum(r.occ_qty)}<span style={{ color: "var(--text-muted)" }}>/{r.qty_valid ? fmtNum(r.cap_qty) : "—"}</span></td>
                <td className="num text-right">{fmtCbm(r.occ_cbm)}<span style={{ color: "var(--text-muted)" }}>/{r.cbm_valid ? fmtCbm(r.cap_cbm) : "—"}</span></td>
                <td className="num text-right">{r.pct_qty === null ? "—" : `${r.pct_qty}%`}</td>
                <td className="num text-right">{r.pct_cbm === null ? "—" : `${r.pct_cbm}%`}</td>
                <td className="num text-right">{r.pct_bin}%</td>
                <td className="num text-right">{r.sku_count}</td>
                <td className="num text-right font-semibold"
                  style={{ color: r.pct >= 100 ? "var(--st-critical-fg)" : "var(--st-warning-fg)" }}>
                  {r.pct}%
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={12} className="py-10 text-center text-xs" style={{ color: "var(--text-muted)" }}>
                {t("dens.noneAbove")}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="density-mobile">
        {sortedRows.map((row) => (
          <button
            key={`${row.sloc_code}-mobile`}
            type="button"
            className="density-mobile-card"
            onClick={() => setSel(row)}
          >
            <div className="density-mobile-head">
              <span>
                <strong className="num">{row.sloc_code}</strong>
                <small>{row.wh} · {row.zone}</small>
              </span>
              <strong className="num" style={{ color: row.pct >= 100 ? "var(--st-critical-fg)" : "var(--st-warning-fg)" }}>
                {row.pct}%
              </strong>
            </div>
            <span className="density-mobile-storage">{row.storage}</span>
            <div className="density-mobile-metrics">
              <span>Qty <b className="num">{row.pct_qty === null ? "—" : `${row.pct_qty}%`}</b></span>
              <span>CBM <b className="num">{row.pct_cbm === null ? "—" : `${row.pct_cbm}%`}</b></span>
              <span>Bin <b className="num">{row.pct_bin}%</b></span>
              <span>SKU <b className="num">{row.sku_count}</b></span>
            </div>
          </button>
        ))}
      </div>

      {sel && (
        <div className="anim-fade fixed inset-0 z-40 flex justify-end" style={{ background: "rgba(8,12,24,0.5)" }}
          onMouseDown={() => setSel(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setSel(null);
          }}>
          <aside className="h-full w-full max-w-sm overflow-y-auto p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="density-detail-title"
            style={{ background: "var(--surface-raised)", borderLeft: "1px solid var(--border)" }}
            onMouseDown={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-start justify-between">
              <div>
                <div className="eyebrow">{sel.wh} · {sel.zone}</div>
                <h3 id="density-detail-title" className="num text-lg font-semibold">{sel.sloc_code}</h3>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setSel(null)}
                aria-label={t("action.close")}>{t("action.close")}</button>
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <StatusBadge status={sel.status as never} />
              <span className="chip">{sel.storage}</span>
              <span className="chip">{sel.basis.toUpperCase()} {sel.pct}%</span>
            </div>
            <div className="eyebrow mb-1.5">{t("heat.contents")} · {sel.sku_count} SKU</div>
            {loading ? (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>{t("common.loading")}</p>
            ) : stock.length === 0 ? (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>{t("heat.emptyCell")}</p>
            ) : (
              <ul className="space-y-1.5">
                {stock.map((s, i) => (
                  <li key={`${s.product_id}-${i}`} className="card anim-in px-3 py-2 text-[11.5px]">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 font-semibold">{s.product_name}</span>
                      <span className="num shrink-0">{fmtNum(s.qty)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2" style={{ color: "var(--text-muted)" }}>
                      <span className="num">{t("common.skuNo")} {s.sku_number}</span>
                      <span className="num">{fmtCbm(s.cbm)} m³</span>
                    </div>
                    <div className="flex items-center justify-between gap-2" style={{ color: "var(--text-muted)" }}>
                      <span className="truncate">{s.l1_category || "—"}</span>
                      {s.status !== "Available" && (
                        <span className="chip" style={{ borderColor: "var(--st-critical-fg)", color: "var(--st-critical-fg)" }}>
                          {s.status}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
