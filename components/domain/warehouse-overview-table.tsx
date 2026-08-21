"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { BasisMode, WarehouseSummary } from "@/types";
import { formatters } from "@/lib/utils";
import { pickViewPct, pickViewStatus } from "@/lib/occupancy-view";
import { useT } from "@/lib/i18n-client";
import OccupancyBar from "@/components/ui/occupancy-bar";

type SortKey = "code" | "pct" | "pct_qty" | "pct_cbm" | "pct_bin" | "sloc_empty" | "hours_to_95";

type Thresholds = { monitor: number; warning: number; critical: number; breach: number };

export default function WarehouseOverviewTable({
  rows, mode, thresholds,
}: {
  rows: WarehouseSummary[];
  mode: BasisMode;
  /**
   * Ambang per gudang, sama dengan yang dipakai kartu dan tabel zona di halaman
   * Okupansi. Tanpa ini bar di sini menggambar tanda 70/85/95 bawaan untuk
   * setiap gudang, sehingga PGS — yang disetel 70/82/92 — memperlihatkan dua
   * posisi tanda yang berbeda pada dua halaman untuk angka yang sama.
   */
  thresholds: Record<string, Thresholds>;
}) {
  const { t, lang } = useT();
  const f = formatters(lang);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "pct", dir: -1 });
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const av = sort.key === "pct" ? pickViewPct(a, mode) : a[sort.key];
    const bv = sort.key === "pct" ? pickViewPct(b, mode) : b[sort.key];
    if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sort.dir;
    return String(av).localeCompare(String(bv), undefined, { numeric: true }) * sort.dir;
  }), [mode, rows, sort]);
  const th = (label: string, key: SortKey, cls = "") => (
    <th className={cls} scope="col"
      aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button className="inline-flex items-center gap-1 hover:text-[var(--text)]"
      aria-label={`${label}, ${sort.key === key && sort.dir === 1 ? "descending" : "ascending"}`}
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir * -1 as 1 | -1) : -1 }))}>
      {label}<span className="text-[10px]" style={{ color: "var(--text-muted)" }}>{sort.key === key ? (sort.dir === 1 ? "↑" : "↓") : "↕"}</span>
    </button></th>
  );
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead><tr>
          {th(t("common.warehouse"), "code")}
          {th(t("common.occupancy"), "pct", "w-[38%]")}
          {th("Qty", "pct_qty", "text-right")}{th("CBM", "pct_cbm", "text-right")}
          {th("Bin", "pct_bin", "text-right")}{th(t("occ.emptySloc"), "sloc_empty", "text-right")}
          {th(t("fc.to95"), "hours_to_95", "text-right")}
        </tr></thead>
        <tbody>{sorted.map((w) => {
          const raw = pickViewPct(w, mode);
          const status = raw === null ? null : pickViewStatus(w, mode);
          return <tr key={w.code}>
            <td><Link href={`/occupancy/${w.code}`} prefetch={false} className="font-semibold hover:underline" style={{ color: "var(--text)" }}>{w.code}</Link>
              <span className="ml-2 text-[10.5px]" style={{ color: "var(--text-muted)" }}>{w.name}</span></td>
            <td><div className="flex items-center gap-2">
              {raw === null || status === null
                ? <span className="occ-track-unavailable flex-1" title={t("heat.unavailable")} />
                : <div className="flex-1"><OccupancyBar pct={raw} status={status}
                    thresholds={thresholds[w.code]}
                    label={`${t("common.occupancy")} ${w.code}`} /></div>}
              <span className="num w-12 text-right text-[12px] font-semibold">{raw === null ? "—" : `${raw}%`}</span>
            </div></td>
            <td className="num text-right">{f.pct(w.pct_qty)}</td><td className="num text-right">{f.pct(w.pct_cbm)}</td>
            <td className="num text-right">{f.pct(w.pct_bin)}</td><td className="num text-right">{f.num(w.sloc_empty)}</td>
            <td className="num text-right">{f.hours(w.hours_to_95)}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  );
}
