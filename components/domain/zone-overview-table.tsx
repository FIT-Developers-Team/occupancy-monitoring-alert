"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { BasisMode, ZoneSummary } from "@/types";
import { fmtNum, fmtPct } from "@/lib/utils";
import { pickViewPct, pickViewStatus } from "@/lib/occupancy-view";
import OccupancyBar from "@/components/ui/occupancy-bar";

type SortKey = "wh" | "zone" | "pct" | "pct_qty" | "pct_cbm" | "pct_bin" | "sloc_occupied";
type Thresholds = { monitor: number; warning: number; critical: number; breach: number };

export default function ZoneOverviewTable({ rows, mode, thresholds }: { rows: ZoneSummary[]; mode: BasisMode; thresholds: Record<string, Thresholds> }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "wh", dir: 1 });
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const av = a[sort.key]; const bv = b[sort.key];
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sort.dir;
    return String(av ?? "").localeCompare(String(bv ?? ""), undefined, { numeric: true }) * sort.dir;
  }), [rows, sort]);
  const th = (label: string, key: SortKey, cls = "") => <th className={cls}><button className="inline-flex items-center gap-1 hover:text-[var(--text)]"
    onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir * -1 as 1 | -1) : 1 }))}>{label}<span className="text-[10px]" style={{ color: "var(--text-muted)" }}>{sort.key === key ? (sort.dir === 1 ? "↑" : "↓") : "↕"}</span></button></th>;
  return <div className="overflow-x-auto"><table className="tbl"><thead><tr>
    {th("Warehouse", "wh")}{th("Zone", "zone")}<th>Storage</th><th>Basis</th><th style={{ width: "22%" }}>Occupancy</th>
    {th("Qty%", "pct_qty", "text-right")}{th("CBM%", "pct_cbm", "text-right")}{th("Bin%", "pct_bin", "text-right")}{th("Filled", "sloc_occupied", "text-right")}
  </tr></thead><tbody>{sorted.map((z) => { const raw = pickViewPct(z, mode); const shown = raw ?? z.pct; return <tr key={`${z.wh}-${z.zone}`}>
    <td className="num font-semibold">{z.wh}</td><td><Link href={`/occupancy/${z.wh}/${encodeURIComponent(z.zone)}`} prefetch={false} className="font-semibold underline decoration-dotted underline-offset-2" style={{ color: "var(--accent)" }}>{z.zone}</Link></td>
    <td className="text-[11px]">{z.storage}</td><td><span className="chip">{z.basis.toUpperCase()}</span></td>
    <td><div className="flex items-center gap-2"><div className="flex-1"><OccupancyBar pct={shown} status={pickViewStatus(z, mode)} thresholds={thresholds[z.wh]} /></div><span className="num w-12 text-right text-[12px] font-semibold">{raw === null ? "—" : `${shown}%`}</span></div></td>
    <td className="num text-right">{fmtPct(z.pct_qty)}</td><td className="num text-right">{fmtPct(z.pct_cbm)}</td><td className="num text-right">{fmtPct(z.pct_bin)}</td><td className="num text-right">{fmtNum(z.sloc_occupied)} / {fmtNum(z.sloc_total)}</td>
  </tr>;})}</tbody></table></div>;
}
