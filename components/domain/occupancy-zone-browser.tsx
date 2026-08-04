"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { BasisMode, OccupancyStatus, ZoneSummary } from "@/types";
import { fmtNum, fmtPct } from "@/lib/utils";
import { pickViewPct, pickViewStatus } from "@/lib/occupancy-view";
import { useT } from "@/lib/i18n-client";
import OccupancyBar from "@/components/ui/occupancy-bar";
import { StatusBadge } from "@/components/ui/badges";

type SortKey = "wh" | "zone" | "pct" | "pct_qty" | "pct_cbm" | "pct_bin" | "sloc_occupied" | "sloc_empty";
type Thresholds = { monitor: number; warning: number; critical: number; breach: number };
type StatusFilter = "ALL" | OccupancyStatus;

export default function OccupancyZoneBrowser({
  rows, mode, thresholds, fixedWarehouse,
}: {
  rows: ZoneSummary[];
  mode: BasisMode;
  thresholds: Record<string, Thresholds>;
  fixedWarehouse?: string;
}) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [warehouse, setWarehouse] = useState(fixedWarehouse ?? "ALL");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "pct", dir: -1 });
  const [page, setPage] = useState(1);

  const warehouses = useMemo(
    () => [...new Set(rows.map((row) => row.wh))].sort((a, b) => a.localeCompare(b)),
    [rows],
  );
  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLocaleLowerCase();
    return rows.filter((row) => {
      if (warehouse !== "ALL" && row.wh !== warehouse) return false;
      if (status !== "ALL" && (pickViewPct(row, mode) === null || pickViewStatus(row, mode) !== status)) return false;
      return !needle || `${row.wh} ${row.zone} ${row.storage}`.toLocaleLowerCase().includes(needle);
    });
  }, [deferredQuery, mode, rows, status, warehouse]);
  const sorted = useMemo(() => [...filtered].sort((a, b) => {
    const av = sort.key === "pct" ? pickViewPct(a, mode) : a[sort.key];
    const bv = sort.key === "pct" ? pickViewPct(b, mode) : b[sort.key];
    if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sort.dir;
    return String(av).localeCompare(String(bv), undefined, { numeric: true }) * sort.dir;
  }), [filtered, mode, sort]);
  const pageSize = 40;
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const visibleRows = useMemo(
    () => sorted.slice((page - 1) * pageSize, page * pageSize),
    [page, sorted],
  );

  useEffect(() => {
    setPage(1);
  }, [deferredQuery, mode, status, warehouse]);
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
        {label}<span aria-hidden>{sort.key === key ? (sort.dir === 1 ? "↑" : "↓") : "↕"}</span>
      </button>
    </th>
  );

  return (
    <div className="occ-zone-browser">
      <div className="occ-zone-toolbar">
        <div className="occ-zone-filters">
          <label>
            <span className="sr-only">{t("occ.searchZone")}</span>
            <input className="input" value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder={t("occ.searchZone")} />
          </label>
          {!fixedWarehouse && (
            <label>
              <span className="sr-only">{t("common.warehouse")}</span>
              <select className="input" value={warehouse} onChange={(event) => setWarehouse(event.target.value)}>
                <option value="ALL">{t("common.allWarehouses")}</option>
                {warehouses.map((code) => <option key={code} value={code}>{code}</option>)}
              </select>
            </label>
          )}
          <label>
            <span className="sr-only">{t("common.status")}</span>
            <select className="input" value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
              <option value="ALL">{t("heat.allStatuses")}</option>
              {(["NORMAL", "MONITOR", "WARNING", "CRITICAL", "BREACH"] as OccupancyStatus[])
                .map((value) => <option key={value} value={value}>{t(`status.${value}`)}</option>)}
            </select>
          </label>
        </div>
        <div className="occ-zone-result">
          <span className="chip chip-accent">{t(`basis.${mode}`)}</span>
          <span className="num">{filtered.length}/{rows.length} {t("common.zone").toLowerCase()}</span>
          <button type="button" className="btn btn-sm" disabled={page <= 1}
            onClick={() => setPage((value) => value - 1)} aria-label={t("action.back")}>←</button>
          <span className="num">{page}/{totalPages}</span>
          <button type="button" className="btn btn-sm" disabled={page >= totalPages}
            onClick={() => setPage((value) => value + 1)} aria-label={`${t("common.zone")} ${page + 1}`}>→</button>
        </div>
      </div>

      <div className="occ-zone-table-wrap">
        <table className="tbl occ-zone-table">
          <thead><tr>
            {!fixedWarehouse && head(t("common.warehouse"), "wh")}
            {head(t("common.zone"), "zone")}
            <th>{t("common.storage")}</th>
            {head(t("common.occupancy"), "pct", "", -1)}
            {head("Qty", "pct_qty", "text-right", -1)}
            {head("CBM", "pct_cbm", "text-right", -1)}
            {head("Bin", "pct_bin", "text-right", -1)}
            {head(t("common.filled"), "sloc_occupied", "text-right", -1)}
            {head(t("common.empty"), "sloc_empty", "text-right", -1)}
          </tr></thead>
          <tbody>
            {visibleRows.map((row) => {
              const raw = pickViewPct(row, mode);
              const shownStatus = raw === null ? null : pickViewStatus(row, mode);
              return (
                <tr key={`${row.wh}-${row.zone}`}>
                  {!fixedWarehouse && <td className="num font-semibold">{row.wh}</td>}
                  <td>
                    <Link href={`/occupancy/${row.wh}/${encodeURIComponent(row.zone)}`} prefetch={false} className="occ-zone-link">
                      {row.zone}
                    </Link>
                  </td>
                  <td><span className="occ-storage" title={row.storage}>{row.storage || "—"}</span></td>
                  <td>
                    <div className="occ-table-meter">
                      {raw === null || shownStatus === null
                        ? <span className="occ-track-unavailable" title={t("heat.unavailable")} />
                        : <OccupancyBar pct={raw} status={shownStatus} thresholds={thresholds[row.wh]}
                            label={`${t("common.occupancy")} ${row.wh} ${row.zone}`} />}
                      <strong className="num">{raw === null ? "—" : `${raw}%`}</strong>
                    </div>
                  </td>
                  <td className="num text-right">{fmtPct(row.pct_qty)}</td>
                  <td className="num text-right">{fmtPct(row.pct_cbm)}</td>
                  <td className="num text-right">{fmtPct(row.pct_bin)}</td>
                  <td className="num text-right">{fmtNum(row.sloc_occupied)}</td>
                  <td className="num text-right">{fmtNum(row.sloc_empty)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="occ-zone-mobile">
        {visibleRows.map((row) => {
          const raw = pickViewPct(row, mode);
          const shownStatus = raw === null ? null : pickViewStatus(row, mode);
          return (
            <Link key={`${row.wh}-${row.zone}`} href={`/occupancy/${row.wh}/${encodeURIComponent(row.zone)}`} prefetch={false}
              className="occ-zone-mobile-card">
              <div className="occ-zone-mobile-head">
                <div><span className="eyebrow">{row.wh} · {t("common.zone")}</span><strong>{row.zone}</strong></div>
                <div className="flex items-center gap-2">
                  <span className="num font-semibold">{raw === null ? "—" : `${raw}%`}</span>
                  {shownStatus && <StatusBadge status={shownStatus} />}
                </div>
              </div>
              <span className="occ-storage">{row.storage || "—"}</span>
              {raw === null || shownStatus === null
                ? <span className="occ-track-unavailable" title={t("heat.unavailable")} />
                : <OccupancyBar pct={raw} status={shownStatus} thresholds={thresholds[row.wh]}
                    label={`${t("common.occupancy")} ${row.wh} ${row.zone}`} />}
              <div className="occ-zone-mobile-metrics">
                <span>Qty <b className="num">{fmtPct(row.pct_qty)}</b></span>
                <span>CBM <b className="num">{fmtPct(row.pct_cbm)}</b></span>
                <span>Bin <b className="num">{fmtPct(row.pct_bin)}</b></span>
                <span>{t("common.empty")} <b className="num">{fmtNum(row.sloc_empty)}</b></span>
              </div>
            </Link>
          );
        })}
      </div>

      {sorted.length === 0 && <div className="occ-empty-state">{t("occ.noZoneMatches")}</div>}
    </div>
  );
}
