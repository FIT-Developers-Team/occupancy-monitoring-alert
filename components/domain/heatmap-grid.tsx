"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { BasisMode, SlocOccupancy, StockLine, ZoneSummary } from "@/types";
import { fmtCbm, fmtNum } from "@/lib/utils";
import { pickViewPct, pickViewStatus } from "@/lib/occupancy-view";
import { useT } from "@/lib/i18n-client";

type HeatStatus =
  | "EMPTY"
  | "OCCUPIED"
  | "NORMAL"
  | "MONITOR"
  | "WARNING"
  | "CRITICAL"
  | "BREACH"
  | "UNAVAILABLE";
type StatusFilter = "ALL" | HeatStatus;

const QUANTITY_STATUS: HeatStatus[] = [
  "EMPTY",
  "NORMAL",
  "MONITOR",
  "WARNING",
  "CRITICAL",
  "BREACH",
  "UNAVAILABLE",
];
const BIN_STATUS: HeatStatus[] = ["EMPTY", "OCCUPIED"];
const CELL_COLOUR: Record<HeatStatus, string> = {
  EMPTY: "var(--surface-sunken)",
  OCCUPIED: "var(--accent)",
  NORMAL: "var(--st-normal-fg)",
  MONITOR: "var(--st-monitor-fg)",
  WARNING: "var(--st-warning-fg)",
  CRITICAL: "var(--st-critical-fg)",
  BREACH: "var(--st-breach-bg)",
  UNAVAILABLE: "var(--border-strong)",
};

interface Movement {
  movement_id: number;
  movement_type: string;
  at: string;
  operator: string;
  source_sloc: string | null;
  destination_sloc: string | null;
  product_name: string | null;
  qty: number;
}

interface HeatLabels {
  openZone: string;
  preview: string;
  occupied: string;
  empty: string;
  sample: string;
}

function readBasis(): BasisMode {
  if (typeof document === "undefined") return "policy";
  const value = document.cookie.match(/wiom_basis=(qty|cbm|bin|policy)/)?.[1];
  return value === "qty" || value === "cbm" || value === "bin" ? value : "policy";
}

function isEmpty(cell: SlocOccupancy) {
  return !cell.occupied;
}

function cellPct(cell: SlocOccupancy, basis: BasisMode) {
  return pickViewPct(cell, basis);
}

function heatStatus(cell: SlocOccupancy, basis: BasisMode): HeatStatus {
  if (isEmpty(cell)) return "EMPTY";
  if (basis === "bin") return "OCCUPIED";
  if (cellPct(cell, basis) === null) return "UNAVAILABLE";
  return pickViewStatus(cell, basis);
}

function shownPct(row: ZoneSummary, basis: BasisMode) {
  return pickViewPct(row, basis);
}

function pctText(value: number | null) {
  return value === null ? "—" : `${Math.round(value * 10) / 10}%`;
}

function trapFocus(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("hidden"));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function navigatePreviewGrid(event: ReactKeyboardEvent<HTMLElement>) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-heat-index]"),
  );
  const current = event.target as HTMLButtonElement;
  const index = Number(current.dataset.heatIndex);
  if (!Number.isInteger(index)) return;
  const delta =
    event.key === "ArrowLeft" ? -1
    : event.key === "ArrowRight" ? 1
    : event.key === "ArrowUp" ? -6
    : event.key === "ArrowDown" ? 6
    : 0;
  const nextIndex =
    event.key === "Home" ? 0
    : event.key === "End" ? buttons.length - 1
    : Math.max(0, Math.min(buttons.length - 1, index + delta));
  if (nextIndex === index) return;
  event.preventDefault();
  current.tabIndex = -1;
  buttons[nextIndex].tabIndex = 0;
  buttons[nextIndex].focus();
}

function CellButton({
  cell,
  basis,
  filter,
  onSelect,
  index,
}: {
  cell: SlocOccupancy;
  basis: BasisMode;
  filter: StatusFilter;
  onSelect: (cell: SlocOccupancy) => void;
  index?: number;
}) {
  const status = heatStatus(cell, basis);
  const pct = cellPct(cell, basis);
  const dimmed = filter !== "ALL" && status !== filter;
  return (
    <button
      type="button"
      role={index === undefined ? undefined : "gridcell"}
      className={`heat-cell-button${dimmed ? " is-muted" : ""}`}
      title={`${cell.sloc_code} · ${status} · ${pctText(pct)}`}
      aria-label={`${cell.sloc_code}, ${status}, ${pctText(pct)}`}
      data-heat-index={index}
      tabIndex={index === undefined || index === 0 ? 0 : -1}
      onClick={() => onSelect(cell)}
    >
      <span
        className={`heat-cell-swatch heat-cell-${status.toLowerCase()}`}
        style={{ backgroundColor: CELL_COLOUR[status] }}
        aria-hidden="true"
      />
    </button>
  );
}

const HeatZoneCard = memo(function HeatZoneCard({
  zone,
  cells,
  basis,
  filter,
  locale,
  labels,
  onSelect,
  onOpen,
}: {
  zone: ZoneSummary;
  cells: SlocOccupancy[];
  basis: BasisMode;
  filter: StatusFilter;
  locale: string;
  labels: HeatLabels;
  onSelect: (cell: SlocOccupancy) => void;
  onOpen: (zone: ZoneSummary) => void;
}) {
  return (
    <article className="heat-zone-card">
      <header className="heat-zone-heading">
        <div className="min-w-0">
          <h2>{zone.zone}</h2>
          <span className="heat-zone-storage" title={zone.storage}>
            {zone.storage || "—"}
          </span>
        </div>
        <strong className="heat-zone-pct num">{pctText(shownPct(zone, basis))}</strong>
      </header>

      <div className="heat-zone-body">
        <div
          className="heat-cell-matrix"
          role="grid"
          aria-label={`${zone.zone} ${labels.preview}`}
          onKeyDown={navigatePreviewGrid}
        >
          {cells.map((cell, index) => (
            <CellButton
              key={`${cell.sloc_id}-${cell.sloc_code}`}
              cell={cell}
              basis={basis}
              filter={filter}
              index={index}
              onSelect={onSelect}
            />
          ))}
        </div>
        <div className="heat-zone-facts">
          <span>
            <b className="num">{zone.sloc_occupied.toLocaleString(locale)}</b>
            {labels.occupied}
          </span>
          <span>
            <b className="num">{zone.sloc_empty.toLocaleString(locale)}</b>
            {labels.empty}
          </span>
          <small className="num">{cells.length}/{zone.sloc_total.toLocaleString(locale)} {labels.sample}</small>
        </div>
      </div>

      <footer className="heat-zone-foot">
        <button type="button" className="heat-zone-open" onClick={() => onOpen(zone)}>
          {labels.openZone}<span aria-hidden="true"> →</span>
        </button>
      </footer>
    </article>
  );
});

export default function HeatmapGrid({
  warehouses,
  initialWh,
  initialSloc,
}: {
  warehouses: string[];
  initialWh: string;
  initialSloc?: string;
}) {
  const { t, lang } = useT();
  const locale = lang === "en" ? "en-GB" : "id-ID";
  const [basis, setBasis] = useState<BasisMode>("policy");
  const [wh, setWh] = useState(initialWh);
  const [zones, setZones] = useState<ZoneSummary[]>([]);
  const [previews, setPreviews] = useState<Record<string, SlocOccupancy[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [initialLookup, setInitialLookup] = useState<"idle" | "loading" | "found" | "missing">(
    initialSloc ? "loading" : "idle",
  );

  const [selectedCell, setSelectedCell] = useState<SlocOccupancy | null>(null);
  const [stock, setStock] = useState<StockLine[]>([]);
  const [moves, setMoves] = useState<Movement[]>([]);
  const [stockLoading, setStockLoading] = useState(false);

  const [selectedZone, setSelectedZone] = useState<ZoneSummary | null>(null);
  const [zoneCells, setZoneCells] = useState<SlocOccupancy[]>([]);
  const [zoneTotal, setZoneTotal] = useState(0);
  const [zoneOffset, setZoneOffset] = useState(0);
  const [zoneNextOffset, setZoneNextOffset] = useState<number | null>(null);
  const [zoneLoading, setZoneLoading] = useState(false);
  const [zoneError, setZoneError] = useState(false);

  const zoneAbortRef = useRef<AbortController | null>(null);
  const initialLookupDoneRef = useRef(false);
  const cellTriggerRef = useRef<HTMLElement | null>(null);
  const zoneTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const refreshBasis = () => {
      setBasis(readBasis());
      setStatusFilter("ALL");
    };
    refreshBasis();
    window.addEventListener("wiom:basis", refreshBasis);
    return () => window.removeEventListener("wiom:basis", refreshBasis);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    setSelectedCell(null);
    setSelectedZone(null);
    fetch(`/api/occupancy/heatmap?wh=${encodeURIComponent(wh)}&summary=1&preview=1`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Heatmap request failed");
        return response.json();
      })
      .then((data) => {
        setZones((data.zones ?? []) as ZoneSummary[]);
        setPreviews((data.previews ?? {}) as Record<string, SlocOccupancy[]>);
      })
      .catch((requestError) => {
        if (requestError?.name === "AbortError") return;
        setError(true);
        setZones([]);
        setPreviews({});
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [wh, reload]);

  useEffect(() => {
    if (!selectedCell) return;
    const controller = new AbortController();
    setStockLoading(true);
    setStock([]);
    setMoves([]);
    fetch(
      `/api/sloc?code=${encodeURIComponent(selectedCell.sloc_code)}&wh=${encodeURIComponent(selectedCell.wh)}`,
      { signal: controller.signal },
    )
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error("SLOC request failed")),
      )
      .then((data) => {
        setStock(data.stock ?? []);
        setMoves(data.movements ?? []);
      })
      .catch((requestError) => {
        if (requestError?.name !== "AbortError") {
          setStock([]);
          setMoves([]);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setStockLoading(false);
      });
    return () => controller.abort();
  }, [selectedCell]);

  const loadZonePage = useCallback(async (
    target: ZoneSummary,
    offset: number,
  ) => {
    zoneAbortRef.current?.abort();
    const controller = new AbortController();
    zoneAbortRef.current = controller;
    setZoneLoading(true);
    setZoneError(false);
    try {
      const response = await fetch(
        `/api/occupancy/heatmap?wh=${encodeURIComponent(wh)}&zone=${encodeURIComponent(target.zone)}&offset=${offset}&limit=600`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error("Zone request failed");
      const data = await response.json();
      if (controller.signal.aborted) return;
      const cells = (data.cells ?? []) as SlocOccupancy[];
      setZoneCells(cells);
      setZoneOffset(offset);
      setZoneTotal(Number(data.total ?? 0));
      setZoneNextOffset(data.nextOffset === null ? null : Number(data.nextOffset));
    } catch (requestError) {
      if ((requestError as { name?: string })?.name !== "AbortError") setZoneError(true);
    } finally {
      if (!controller.signal.aborted) setZoneLoading(false);
    }
  }, [wh]);

  useEffect(() => {
    if (!selectedZone) return;
    setZoneCells([]);
    setZoneTotal(0);
    setZoneOffset(0);
    setZoneNextOffset(null);
    void loadZonePage(selectedZone, 0);
    return () => zoneAbortRef.current?.abort();
  }, [loadZonePage, selectedZone]);

  useEffect(() => {
    if (!selectedCell && !selectedZone) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [selectedCell, selectedZone]);

  const openCell = useCallback((cell: SlocOccupancy) => {
    cellTriggerRef.current = document.activeElement as HTMLElement | null;
    setSelectedCell(cell);
  }, []);
  const closeCell = useCallback(() => {
    setSelectedCell(null);
    requestAnimationFrame(() => cellTriggerRef.current?.focus());
  }, []);
  const openZone = useCallback((zone: ZoneSummary) => {
    zoneTriggerRef.current = document.activeElement as HTMLElement | null;
    setSelectedZone(zone);
  }, []);
  const closeZone = useCallback(() => {
    setSelectedZone(null);
    setZoneCells([]);
    setZoneOffset(0);
    requestAnimationFrame(() => zoneTriggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!initialSloc || initialLookupDoneRef.current) return;
    initialLookupDoneRef.current = true;
    const controller = new AbortController();
    setInitialLookup("loading");
    fetch(
      `/api/occupancy/heatmap?wh=${encodeURIComponent(initialWh)}&sloc=${encodeURIComponent(initialSloc)}`,
      { signal: controller.signal },
    )
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error("SLOC lookup failed")),
      )
      .then((data) => {
        const cell = data.cell as SlocOccupancy | null;
        if (!cell) {
          setInitialLookup("missing");
          return;
        }
        setInitialLookup("found");
        openCell(cell);
      })
      .catch((requestError) => {
        if (requestError?.name !== "AbortError") setInitialLookup("missing");
      });
    return () => controller.abort();
  }, [initialSloc, initialWh, openCell]);

  const statusOptions = basis === "bin" ? BIN_STATUS : QUANTITY_STATUS;

  const totals = useMemo(() => {
    const total = zones.reduce((sum, zone) => sum + zone.sloc_total, 0);
    const empty = zones.reduce((sum, zone) => sum + zone.sloc_empty, 0);
    const occupied = Math.max(0, total - empty);
    let numerator = 0;
    let denominator = 0;
    if (basis === "qty") {
      zones.forEach((zone) => {
        if (zone.cap_qty > 0 && zone.pct_qty !== null) {
          numerator += zone.cap_qty * zone.pct_qty / 100;
          denominator += zone.cap_qty;
        }
      });
    } else if (basis === "cbm") {
      zones.forEach((zone) => {
        if (zone.cap_cbm > 0 && zone.pct_cbm !== null) {
          numerator += zone.cap_cbm * zone.pct_cbm / 100;
          denominator += zone.cap_cbm;
        }
      });
    } else if (basis === "policy") {
      zones.forEach((zone) => {
        numerator += zone.sloc_total * zone.pct;
        denominator += zone.sloc_total;
      });
    }
    const occupancy = basis === "bin"
      ? (total > 0 ? occupied / total * 100 : null)
      : (denominator > 0 ? numerator / denominator * 100 : null);
    return { total, empty, occupied, occupancy };
  }, [basis, zones]);

  // Preview cells are a bounded sample. Never hide a whole zone from a status
  // filter based on that sample; dim non-matching cells while retaining the
  // authoritative zone index.
  const visibleZones = zones;

  const statusLabel = useCallback((status: HeatStatus) => {
    if (status === "EMPTY") return t("heat.emptyLegend");
    if (status === "OCCUPIED") return t("common.filled");
    if (status === "UNAVAILABLE") return t("heat.unavailable");
    return t(`status.${status}`);
  }, [t]);

  const labels = useMemo<HeatLabels>(() => ({
    openZone: t("heat.openZone"),
    preview: t("heat.previewCells"),
    occupied: t("common.filled"),
    empty: t("common.empty"),
    sample: t("heat.sample"),
  }), [t]);
  const selectedPct = selectedCell ? cellPct(selectedCell, basis) : null;
  const selectedStatus = selectedCell ? heatStatus(selectedCell, basis) : null;

  return (
    <div className="heatmap-shell card">
      <div className="heatmap-toolbar">
        <label className="heat-select">
          <span className="sr-only">{t("heat.selectWarehouse")}</span>
          <select
            className="input"
            value={wh}
            onChange={(event) => setWh(event.target.value)}
            aria-label={t("heat.selectWarehouse")}
          >
            {warehouses.map((warehouse) => (
              <option key={warehouse} value={warehouse}>{warehouse}</option>
            ))}
          </select>
        </label>

        <div className="heat-legend" aria-label={t("heat.legend")}>
          {statusOptions.map((status) => (
            <button
              type="button"
              key={status}
              className={`heat-legend-item${statusFilter === status ? " is-active" : ""}`}
              aria-pressed={statusFilter === status}
              onClick={() => setStatusFilter((current) => current === status ? "ALL" : status)}
            >
              <i style={{ backgroundColor: CELL_COLOUR[status] }} aria-hidden="true" />
              <span>{statusLabel(status)}</span>
            </button>
          ))}
        </div>

        <div className="heat-toolbar-meta" aria-live="polite">
          {initialSloc ? (
            <span>
              {t(
                initialLookup === "missing"
                  ? "heat.initialSlocMissing"
                  : initialLookup === "found"
                    ? "heat.initialSloc"
                    : "heat.initialSlocLoading",
              ).replace("{sloc}", initialSloc)}
            </span>
          ) : (
            <>
              <span><b className="num">{visibleZones.length}</b> {t("heat.zonesShown")}</span>
              <span aria-hidden="true">·</span>
              <span><b className="num">{loading ? "—" : totals.total.toLocaleString(locale)}</b> SLOC</span>
            </>
          )}
        </div>
      </div>

      <div className="heatmap-content">
        {loading ? (
          <div className="heat-zone-cards" aria-busy="true" aria-label={t("heat.loading")}>
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="heat-zone-card heat-zone-skeleton" />
            ))}
          </div>
        ) : error ? (
          <div className="heatmap-feedback">
            <strong>{t("heat.loadError")}</strong>
            <button type="button" className="btn btn-sm" onClick={() => setReload((value) => value + 1)}>
              {t("heat.retry")}
            </button>
          </div>
        ) : zones.length === 0 ? (
          <div className="heatmap-feedback"><strong>{t("heat.noZones")}</strong></div>
        ) : (
          <div className="heat-zone-cards">
            {visibleZones.map((zone) => (
              <HeatZoneCard
                key={zone.zone}
                zone={zone}
                cells={previews[zone.zone] ?? []}
                basis={basis}
                filter={statusFilter}
                locale={locale}
                labels={labels}
                onSelect={openCell}
                onOpen={openZone}
              />
            ))}
          </div>
        )}
      </div>

      {selectedZone && (
        <div
          className="heat-zone-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target && !selectedCell) closeZone();
          }}
        >
          <section
            className="heat-zone-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="heat-zone-dialog-title"
            onKeyDown={(event) => {
              trapFocus(event);
              if (event.key === "Escape" && !selectedCell) closeZone();
            }}
          >
            <header className="heat-zone-dialog-head">
              <div className="min-w-0">
                <span className="eyebrow">{wh} · {t("heat.fullZone")}</span>
                <h2 id="heat-zone-dialog-title">
                  {selectedZone.zone}
                  <span>{selectedZone.storage || "—"}</span>
                </h2>
              </div>
              <button type="button" autoFocus className="btn btn-ghost btn-sm" onClick={closeZone}>
                {t("action.close")}
              </button>
            </header>

            <div className="heat-zone-dialog-summary">
              <span><b className="num">{zoneCells.length.toLocaleString(locale)}</b> {t("heat.loadedCells")}</span>
              <span><b className="num">{zoneTotal.toLocaleString(locale)}</b> {t("common.total").toLowerCase()}</span>
              <span><b className="num">{pctText(shownPct(selectedZone, basis))}</b> {t(`basis.${basis}`)}</span>
            </div>

            {zoneError && zoneCells.length === 0 ? (
              <div className="heatmap-feedback">
                <strong>{t("heat.loadError")}</strong>
                <button type="button" className="btn btn-sm" onClick={() => void loadZonePage(selectedZone, zoneOffset)}>
                  {t("heat.retry")}
                </button>
              </div>
            ) : (
              <div className="heat-zone-dialog-grid-wrap" aria-busy={zoneLoading}>
                <div className="heat-zone-dialog-grid" role="group" aria-label={`${selectedZone.zone} SLOC`}>
                  {zoneCells.map((cell) => (
                    <CellButton
                      key={`${cell.sloc_id}-${cell.sloc_code}`}
                      cell={cell}
                      basis={basis}
                      filter={statusFilter}
                      onSelect={openCell}
                    />
                  ))}
                </div>
                {zoneLoading && zoneCells.length === 0 && (
                  <div className="heat-zone-loading">{t("common.loading")}</div>
                )}
              </div>
            )}

            <footer className="heat-zone-dialog-foot">
              <span className="num">
                {zoneCells.length
                  ? `${(zoneOffset + 1).toLocaleString(locale)}–${Math.min(zoneOffset + zoneCells.length, zoneTotal).toLocaleString(locale)} / ${zoneTotal.toLocaleString(locale)}`
                  : `0 / ${zoneTotal.toLocaleString(locale)}`}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={zoneLoading || zoneOffset === 0}
                  onClick={() => void loadZonePage(selectedZone, Math.max(0, zoneOffset - 600))}
                >
                  {t("action.back")}
                </button>
                {zoneNextOffset !== null && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={zoneLoading}
                  onClick={() => void loadZonePage(selectedZone, zoneNextOffset)}
                >
                  {zoneLoading ? t("common.loading") : t("heat.loadMore")}
                </button>
                )}
              </div>
            </footer>
          </section>
        </div>
      )}

      {selectedCell && selectedStatus && (
        <div
          className="heat-detail-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) closeCell();
          }}
        >
          <aside
            className="heat-detail-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="heatmap-detail-title"
            onKeyDown={(event) => {
              trapFocus(event);
              if (event.key === "Escape") closeCell();
            }}
          >
            <div className="heat-detail-header">
              <div className="min-w-0">
                <div className="eyebrow">
                  {selectedCell.wh} · {selectedCell.zone} · {selectedCell.rack_zone}
                </div>
                <h2 id="heatmap-detail-title" className="num">{selectedCell.sloc_code}</h2>
              </div>
              <button type="button" autoFocus className="btn btn-ghost btn-sm" onClick={closeCell}>
                {t("action.close")}
              </button>
            </div>

            <div className="heat-detail-status-row">
              <span className="heat-status-pill">
                <i style={{ backgroundColor: CELL_COLOUR[selectedStatus] }} aria-hidden="true" />
                {statusLabel(selectedStatus)}
              </span>
              <span className="chip">{t(`basis.${basis}`)} {pctText(selectedPct)}</span>
              <span className="chip">{selectedCell.product_count} {t("common.sku")}</span>
            </div>

            <div className="heat-detail-metrics">
              <div>
                <span className="eyebrow">{t("heat.qty")}</span>
                <strong className="num">
                  {fmtNum(selectedCell.occ_qty)}/{selectedCell.qty_valid ? fmtNum(selectedCell.cap_qty) : "—"}
                </strong>
              </div>
              <div>
                <span className="eyebrow">CBM</span>
                <strong className="num">
                  {fmtCbm(selectedCell.occ_cbm)}/{selectedCell.cbm_valid ? fmtCbm(selectedCell.cap_cbm) : "—"}
                </strong>
              </div>
              <div>
                <span className="eyebrow">Bin</span>
                <strong>{selectedCell.occupied ? t("heat.binFilled") : t("heat.binEmpty")}</strong>
              </div>
            </div>

            <section className="heat-detail-section">
              <div className="eyebrow">{t("heat.skuAtLocation")}</div>
              {stockLoading ? (
                <p className="heat-detail-muted">{t("common.loading")}</p>
              ) : stock.length === 0 ? (
                <p className="heat-detail-muted">{t("heat.noStock")}</p>
              ) : (
                <ul className="heat-detail-list">
                  {stock.map((stockLine, index) => (
                    <li key={`${stockLine.product_id}-${stockLine.status}-${index}`}>
                      <div>
                        <strong title={stockLine.product_name}>{stockLine.product_name}</strong>
                        <span className="num">SKU {stockLine.sku_number}</span>
                      </div>
                      <div className="heat-detail-list-value">
                        <b className="num">{fmtNum(stockLine.qty)}</b>
                        <span>{fmtCbm(stockLine.cbm)} m³</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="heat-detail-section">
              <div className="eyebrow">{t("heat.lastMovement")}</div>
              {moves.length === 0 ? (
                <p className="heat-detail-muted">{t("heat.noMovementSynced")}</p>
              ) : (
                <ul className="heat-detail-list">
                  {moves.map((movement) => (
                    <li key={movement.movement_id}>
                      <div>
                        <strong>{movement.movement_type}</strong>
                        <span className="num">
                          {new Date(movement.at).toLocaleString(locale)}
                        </span>
                        <span className="num">
                          {movement.source_sloc ?? "—"} → {movement.destination_sloc ?? "—"}
                        </span>
                      </div>
                      <div className="heat-detail-list-value">
                        <b className="num">{fmtNum(movement.qty)}</b>
                        <span>{movement.operator}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}
