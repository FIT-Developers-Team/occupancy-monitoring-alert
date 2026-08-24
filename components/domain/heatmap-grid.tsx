"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { BasisMode, RackZoneSummary, SlocOccupancy, StockLine, ZoneSummary } from "@/types";
import { formatters } from "@/lib/utils";
import type { MovementRow } from "@/lib/movements";
import { pickViewPct, pickViewStatus } from "@/lib/occupancy-view";
import { useT } from "@/lib/i18n-client";
import { trapFocus } from "@/lib/focus-trap";
import ExportExcelButton from "@/components/domain/export-excel-button";

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
  EMPTY: "transparent",
  OCCUPIED: "var(--accent)",
  NORMAL: "var(--heat-normal)",
  MONITOR: "var(--heat-monitor)",
  WARNING: "var(--heat-warning)",
  CRITICAL: "var(--heat-critical)",
  BREACH: "var(--heat-breach)",
  UNAVAILABLE: "var(--border-strong)",
};
const naturalOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

type Movement = MovementRow;

interface HeatLabels {
  openZone: string;
  preview: string;
  occupied: string;
  empty: string;
  sample: string;
  order: string;
}

function rackPosition(rackZone: string, t: (key: string, fallback?: string) => string) {
  const suffix = rackZone.match(/(\d+)$/)?.[1];
  if (suffix === "1") return t("heat.position.bottom");
  if (suffix === "2") return t("heat.position.middle");
  if (suffix === "3") return t("heat.position.top");
  return t("heat.position.section");
}

function sortCells(cells: SlocOccupancy[]) {
  return [...cells].sort((a, b) =>
    naturalOrder.compare(a.aisle, b.aisle)
    || naturalOrder.compare(a.bay, b.bay)
    || naturalOrder.compare(a.level, b.level)
    || naturalOrder.compare(a.bin, b.bin)
    || naturalOrder.compare(a.sloc_code, b.sloc_code));
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
    : event.key === "ArrowUp" ? -4
    : event.key === "ArrowDown" ? 4
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
  t,
  onSelect,
  index,
  showCoordinates = false,
  binLabel = false,
}: {
  cell: SlocOccupancy;
  basis: BasisMode;
  filter: StatusFilter;
  t: (key: string, fallback?: string) => string;
  onSelect: (cell: SlocOccupancy) => void;
  index?: number;
  showCoordinates?: boolean;
  binLabel?: boolean;
}) {
  const status = heatStatus(cell, basis);
  const pct = cellPct(cell, basis);
  const dimmed = filter !== "ALL" && status !== filter;
  // Kotak ini tidak memuat teks apa pun, jadi tooltip-nya adalah satu-satunya
  // tempat statusnya terbaca sebagai kata. Ia harus memakai kata yang sama
  // dengan legenda tepat di atasnya; sebelumnya di sini muncul nama enum mentah
  // ("BREACH") sementara legendanya menulis "Breach" atau terjemahannya.
  const coordinates = [
    `${t("heat.aisle")} ${cell.aisle || "—"}`,
    `${t("heat.bay")} ${cell.bay || "—"}`,
    `${t("heat.level")} ${cell.level || "—"}`,
    `${t("heat.bin")} ${cell.bin || "—"}`,
  ];
  const reading = [cell.sloc_code, ...coordinates, t(`heat.legendStatus.${status}`), pctText(pct)];
  return (
    <button
      type="button"
      role={index === undefined ? undefined : "gridcell"}
      className={`heat-cell-button${showCoordinates ? " heat-cell-coordinate" : ""}${binLabel ? " heat-cell-bin" : ""}${dimmed ? " is-muted" : ""}`}
      title={reading.join(" · ")}
      aria-label={reading.join(", ")}
      data-heat-index={index}
      tabIndex={index === undefined || index === 0 ? 0 : -1}
      onClick={() => onSelect(cell)}
    >
      <span
        className={`heat-cell-swatch heat-cell-${status.toLowerCase()}`}
        style={{ backgroundColor: CELL_COLOUR[status] }}
        aria-hidden="true"
      >
        {showCoordinates && (
          <>
            <b>B{cell.bay || "—"}</b>
            <small>L{cell.level || "—"} · {cell.bin || "—"}</small>
          </>
        )}
        {/* Inside the zone layout the aisle, bay and level are already row
            labels, so the cell itself only needs to identify its bin. */}
        {binLabel && !showCoordinates && <b>{cell.bin || "—"}</b>}
      </span>
    </button>
  );
}

interface ZoneBayGroup {
  bay: string;
  levels: Array<{ level: string; cells: SlocOccupancy[] }>;
  total: number;
  filled: number;
  /** Bin count of the densest level — drives how wide this bay has to be. */
  maxBins: number;
}

// Warehouses differ a lot: a level holds anywhere from 2 to ~30 bins. One fixed
// bay width would either waste space or squeeze bins into unreadable slivers, so
// each bay is sized from its own densest level and then clamped so the grid
// still tiles predictably.
const BIN_MIN_PX = 22;
const BAY_CHROME_PX = 38;
const BAY_MIN_PX = 268;
const BAY_MAX_PX = 900;

function bayWidthPx(maxBins: number): number {
  return Math.min(BAY_MAX_PX, Math.max(BAY_MIN_PX, maxBins * BIN_MIN_PX + BAY_CHROME_PX));
}

/** Physical racks label tiers L1..Ln; the data stores them bare to match capacity scopes. */
function levelLabel(level: string): string {
  return /^\d+$/.test(level) ? `L${level}` : level;
}
interface ZoneAisleGroup {
  aisle: string;
  bays: ZoneBayGroup[];
  total: number;
  filled: number;
}

/**
 * Rebuild the physical rack layout (Aisle -> Bay -> Level -> Bin) from the flat
 * SLOC rows the API returns. The zone dialog used to render every cell as one
 * undifferentiated wall, so there was no way to tell which bay or level a cell
 * belonged to.
 */
function groupZoneByPosition(cells: SlocOccupancy[]): ZoneAisleGroup[] {
  const byAisle = new Map<string, Map<string, Map<string, SlocOccupancy[]>>>();
  for (const cell of sortCells(cells)) {
    const aisle = cell.aisle || "—";
    const bay = cell.bay || "—";
    const level = cell.level || "—";
    let bays = byAisle.get(aisle);
    if (!bays) { bays = new Map(); byAisle.set(aisle, bays); }
    let levels = bays.get(bay);
    if (!levels) { levels = new Map(); bays.set(bay, levels); }
    const list = levels.get(level) ?? [];
    list.push(cell);
    levels.set(level, list);
  }

  const aisles: ZoneAisleGroup[] = [];
  for (const [aisle, bays] of byAisle) {
    const bayGroups: ZoneBayGroup[] = [];
    let aisleTotal = 0;
    let aisleFilled = 0;
    for (const [bay, levels] of bays) {
      // Highest level first so a bay reads like a real rack elevation.
      const levelRows = [...levels.entries()]
        .sort((a, b) => naturalOrder.compare(b[0], a[0]))
        .map(([level, list]) => ({ level, cells: list }));
      let total = 0;
      let filled = 0;
      let maxBins = 0;
      for (const row of levelRows) {
        total += row.cells.length;
        filled += row.cells.filter((cell) => !isEmpty(cell)).length;
        maxBins = Math.max(maxBins, row.cells.length);
      }
      aisleTotal += total;
      aisleFilled += filled;
      bayGroups.push({ bay, levels: levelRows, total, filled, maxBins });
    }
    aisles.push({ aisle, bays: bayGroups, total: aisleTotal, filled: aisleFilled });
  }
  return aisles;
}

const ZoneLayout = memo(function ZoneLayout({
  aisles,
  basis,
  filter,
  locale,
  label,
  t,
  onSelect,
}: {
  aisles: ZoneAisleGroup[];
  basis: BasisMode;
  filter: StatusFilter;
  locale: string;
  label: string;
  t: (key: string, fallback?: string) => string;
  onSelect: (cell: SlocOccupancy) => void;
}) {
  if (!aisles.length) return null;
  return (
    <div className="zone-layout" role="group" aria-label={label}>
      {aisles.map((aisleGroup) => (
        <section key={aisleGroup.aisle} className="zone-aisle">
          <header className="zone-aisle-head">
            <h3>
              <span>{t("heat.aisle")}</span>
              <strong className="num">{aisleGroup.aisle}</strong>
            </h3>
            <span className="zone-aisle-stat num">
              <b>{aisleGroup.filled.toLocaleString(locale)}</b>
              <small>{t("heat.filled")}</small>
              <i aria-hidden>·</i>
              {/* Empty ACTIVE bins are usable capacity, so they get their own
                  number rather than being implied by the difference. */}
              <b>{(aisleGroup.total - aisleGroup.filled).toLocaleString(locale)}</b>
              <small>{t("heat.emptyActive")}</small>
            </span>
          </header>
          <div className="zone-bay-list">
            {aisleGroup.bays.map((bayGroup) => (
              <article
                key={bayGroup.bay}
                className="zone-bay"
                style={{ "--bay-min": `${bayWidthPx(bayGroup.maxBins)}px` } as CSSProperties}
              >
                <header className="zone-bay-head">
                  <span>
                    <b>{t("heat.bay")}</b>
                    <strong className="num">{bayGroup.bay}</strong>
                  </span>
                  <small className="num">{bayGroup.filled}/{bayGroup.total}</small>
                </header>
                <div className="zone-bay-levels">
                  {bayGroup.levels.map((row) => (
                    <div key={row.level} className="zone-level-row">
                      <span className="zone-level-label num" title={`${t("heat.level")} ${row.level}`}>
                        {levelLabel(row.level)}
                      </span>
                      <div className="zone-bin-row">
                        {row.cells.map((cell) => (
                          <CellButton
                            key={`${cell.sloc_id}-${cell.sloc_code}`}
                            cell={cell}
                            basis={basis}
                            filter={filter}
                            t={t}
                            onSelect={onSelect}
                            binLabel
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
});

const HeatZoneGroup = memo(function HeatZoneGroup({
  zone,
  previews,
  basis,
  filter,
  locale,
  labels,
  t,
  onSelect,
  onOpen,
}: {
  zone: ZoneSummary;
  previews: Record<string, SlocOccupancy[]>;
  basis: BasisMode;
  filter: StatusFilter;
  locale: string;
  labels: HeatLabels;
  t: (key: string, fallback?: string) => string;
  onSelect: (cell: SlocOccupancy) => void;
  onOpen: (zone: RackZoneSummary) => void;
}) {
  const rackZones: RackZoneSummary[] = zone.rack_zones?.length
    ? zone.rack_zones
    : [{ ...zone, rack_zone: zone.zone }];
  return (
    <article className="heat-zone-card heat-zone-group">
      <header className="heat-zone-heading">
        <div className="min-w-0">
          <span className="eyebrow">{t("heat.zoneGroup")}</span>
          <h2>{zone.zone}</h2>
          <span className="heat-zone-storage" title={zone.storage}>
            {zone.storage || "—"}
          </span>
        </div>
        <div className="heat-zone-total">
          <strong className="heat-zone-pct num">{pctText(shownPct(zone, basis))}</strong>
          <small className="num">{zone.sloc_total.toLocaleString(locale)} SLOC</small>
        </div>
      </header>

      <div className="heat-rack-list">
        {rackZones.map((rack) => {
          const cells = sortCells(previews[`${zone.zone}|${rack.rack_zone}`] ?? []);
          const byAisle = new Map<string, SlocOccupancy[]>();
          for (const cell of cells) {
            const aisle = cell.aisle || "—";
            const aisleCells = byAisle.get(aisle) ?? [];
            aisleCells.push(cell);
            byAisle.set(aisle, aisleCells);
          }
          return (
            <section key={rack.rack_zone} className="heat-rack-section">
              <header className="heat-rack-head">
                <div>
                  <h3 className="num">{rack.rack_zone}</h3>
                  <span>{rackPosition(rack.rack_zone, t)}</span>
                </div>
                <div className="heat-rack-head-meta">
                  <strong className="num">{pctText(shownPct(rack, basis))}</strong>
                  <small>{rack.sloc_total.toLocaleString(locale)} SLOC</small>
                </div>
              </header>
              <div className="heat-rack-order">{labels.order}</div>
              <div className="heat-aisle-list">
                {[...byAisle.entries()].map(([aisle, aisleCells]) => (
                  <div key={aisle} className="heat-aisle-row">
                    <span className="heat-aisle-label"><b>{t("heat.aisle")}</b><strong className="num">{aisle}</strong></span>
                    <div
                      className="heat-cell-matrix heat-cell-coordinate-matrix"
                      role="grid"
                      aria-label={`${rack.rack_zone}, Aisle ${aisle}, ${labels.preview}`}
                      onKeyDown={navigatePreviewGrid}
                    >
                      {aisleCells.map((cell, index) => (
                        <CellButton
                          key={`${cell.sloc_id}-${cell.sloc_code}`}
                          cell={cell}
                          basis={basis}
                          filter={filter}
                          t={t}
                          index={index}
                          showCoordinates
                          onSelect={onSelect}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <footer className="heat-rack-foot">
                <span className="num">{rack.sloc_occupied.toLocaleString(locale)} {labels.occupied} · {rack.sloc_empty.toLocaleString(locale)} {labels.empty}</span>
                <button type="button" className="heat-zone-open" onClick={() => onOpen(rack)}>
                  {labels.openZone} {rack.rack_zone}<span aria-hidden="true"> →</span>
                </button>
              </footer>
            </section>
          );
        })}
      </div>
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
  const f = formatters(lang);
  // Satu sumber locale untuk seluruh komponen ini: `toLocaleString` di bawah
  // dan pemformat bersama harus tidak mungkin memakai konvensi yang berbeda.
  const locale = f.locale;
  const [basis, setBasis] = useState<BasisMode>("policy");
  const [wh, setWh] = useState(initialWh);
  const [zones, setZones] = useState<ZoneSummary[]>([]);
  const [previews, setPreviews] = useState<Record<string, SlocOccupancy[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [zoneQuery, setZoneQuery] = useState("");
  const [slocQuery, setSlocQuery] = useState("");
  const [slocLookup, setSlocLookup] = useState<"idle" | "loading" | "missing">("idle");
  const [initialLookup, setInitialLookup] = useState<"idle" | "loading" | "found" | "missing">(
    initialSloc ? "loading" : "idle",
  );

  const [selectedCell, setSelectedCell] = useState<SlocOccupancy | null>(null);
  const [stock, setStock] = useState<StockLine[]>([]);
  const [moves, setMoves] = useState<Movement[]>([]);
  const [stockLoading, setStockLoading] = useState(false);

  const [selectedZone, setSelectedZone] = useState<RackZoneSummary | null>(null);
  const [zoneCells, setZoneCells] = useState<SlocOccupancy[]>([]);
  const [zoneTotal, setZoneTotal] = useState(0);
  const [zoneOffset, setZoneOffset] = useState(0);
  const [zoneNextOffset, setZoneNextOffset] = useState<number | null>(null);
  const [zoneLoading, setZoneLoading] = useState(false);
  const [zoneError, setZoneError] = useState(false);

  // Regrouping 600 cells on every render would be wasteful; only the loaded
  // page changes.
  const zoneAisles = useMemo(() => groupZoneByPosition(zoneCells), [zoneCells]);

  const zoneAbortRef = useRef<AbortController | null>(null);
  const lookupAbortRef = useRef<AbortController | null>(null);
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
    target: RackZoneSummary,
    offset: number,
  ) => {
    zoneAbortRef.current?.abort();
    const controller = new AbortController();
    zoneAbortRef.current = controller;
    setZoneLoading(true);
    setZoneError(false);
    try {
      const response = await fetch(
        `/api/occupancy/heatmap?wh=${encodeURIComponent(wh)}&zone=${encodeURIComponent(target.zone)}&rackZone=${encodeURIComponent(target.rack_zone)}&offset=${offset}&limit=600`,
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
  const openZone = useCallback((zone: RackZoneSummary) => {
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

  // Preview cells are a bounded sample. Never hide a whole zone from a status
  // filter based on that sample; dim non-matching cells while retaining the
  // authoritative zone index. Pencarian zona aman disaring di sini karena
  // indeks zona itu lengkap — berbeda dengan sel pratinjaunya.
  const visibleZones = useMemo(() => {
    const tokens = zoneQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return zones;
    return zones.filter((zone) => {
      const haystack = [
        zone.zone,
        zone.storage,
        ...(zone.rack_zones ?? []).map((rack) => rack.rack_zone),
      ].join(" ").toLocaleLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
  }, [zoneQuery, zones]);

  /**
   * Ringkasan gudang pada baris toolbar.
   *
   * Dua hal diperbaiki di sini sekaligus.
   *
   * Pertama, angkanya mengikuti zona yang BENAR-BENAR tampil. Sebelumnya jumlah
   * SLOC selalu mencakup seluruh gudang, sehingga menyaring zona menghasilkan
   * baris yang menyebut tiga zona tepat di sebelah angka SLOC milik lima belas
   * zona.
   *
   * Kedua, okupansi gabungan dijumlahkan sebagai isi dibagi kapasitas — cara
   * yang sama dengan kartu gudang di halaman Okupansi. Bentuk sebelumnya
   * merata-ratakan persentase tiap zona dengan bobot jumlah SLOC. Itu statistik
   * yang berbeda: ia tidak pernah dapat melewati persentase zona tertingginya,
   * sekalipun gudangnya secara keseluruhan sudah melewati kapasitas, sehingga
   * heatmap dan halaman Okupansi dapat menyebut angka berbeda untuk gudang yang
   * sama.
   */
  const totals = useMemo(() => {
    const total = visibleZones.reduce((sum, zone) => sum + zone.sloc_total, 0);
    const empty = visibleZones.reduce((sum, zone) => sum + zone.sloc_empty, 0);
    const occupied = Math.max(0, total - empty);

    const ratio = (
      capacityOf: (zone: ZoneSummary) => number,
      pctOf: (zone: ZoneSummary) => number | null,
    ) => {
      let filled = 0;
      let capacity = 0;
      for (const zone of visibleZones) {
        const cap = capacityOf(zone);
        const pct = pctOf(zone);
        if (cap <= 0 || pct === null) continue;
        filled += cap * pct / 100;
        capacity += cap;
      }
      return capacity > 0 ? filled / capacity * 100 : null;
    };
    const qty = ratio((zone) => zone.cap_qty, (zone) => zone.pct_qty);
    const cbm = ratio((zone) => zone.cap_cbm, (zone) => zone.pct_cbm);
    const bin = total > 0 ? occupied / total * 100 : null;
    // Basis kebijakan gudang adalah basis yang dipakai mayoritas lokasinya,
    // dengan cadangan basis satunya bila kapasitasnya belum tersedia — aturan
    // yang sama persis dengan read model gudang di server.
    const cbmSlocs = visibleZones.reduce(
      (sum, zone) => sum + (zone.basis === "cbm" ? zone.sloc_total : 0), 0);
    const policy = cbmSlocs > total / 2 ? (cbm ?? qty) : (qty ?? cbm);
    const occupancy =
      basis === "qty" ? qty
      : basis === "cbm" ? cbm
      : basis === "bin" ? bin
      : policy;
    return { total, empty, occupied, occupancy };
  }, [basis, visibleZones]);

  const statusLabel = useCallback((status: HeatStatus) => {
    return t(`heat.legendStatus.${status}`);
  }, [t]);

  const labels = useMemo<HeatLabels>(() => ({
    openZone: t("heat.openZone"),
    preview: t("heat.previewCells"),
    occupied: t("common.filled"),
    empty: t("common.empty"),
    sample: t("heat.sample"),
    order: t("heat.coordinateOrder"),
  }), [t]);
  const selectedPct = selectedCell ? cellPct(selectedCell, basis) : null;
  const selectedStatus = selectedCell ? heatStatus(selectedCell, basis) : null;

  // Mencari satu kode SLOC harus menemukannya di mana pun ia berada di gudang
  // ini, bukan hanya di antara sel pratinjau yang kebetulan tergambar.
  //
  // Pencarian sebelumnya dibiarkan berlari sendiri. Dua pencarian berurutan —
  // mengetik satu kode, lalu langsung mengoreksinya — berlomba, dan jawaban
  // yang datang belakangan belum tentu jawaban yang diminta terakhir: panel
  // dapat terbuka pada lokasi yang SUDAH TIDAK dicari lagi, tanpa satu pun
  // petunjuk di layar bahwa yang tampil bukan yang diketik. Pola pembatalannya
  // sama dengan setiap permintaan lain di komponen ini.
  const lookupSloc = useCallback(async (code: string) => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;
    lookupAbortRef.current?.abort();
    const controller = new AbortController();
    lookupAbortRef.current = controller;
    setSlocLookup("loading");
    try {
      const response = await fetch(
        `/api/occupancy/heatmap?wh=${encodeURIComponent(wh)}&sloc=${encodeURIComponent(trimmed)}`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error("SLOC lookup failed");
      const data = await response.json();
      if (controller.signal.aborted) return;
      const cell = data.cell as SlocOccupancy | null;
      if (!cell) {
        setSlocLookup("missing");
        return;
      }
      setSlocLookup("idle");
      openCell(cell);
    } catch (requestError) {
      // Pembatalan bukan kegagalan: pencarian berikutnya yang akan melaporkan
      // hasilnya, jadi menandai "tidak ditemukan" di sini justru salah.
      if ((requestError as { name?: string })?.name !== "AbortError") setSlocLookup("missing");
    }
  }, [openCell, wh]);

  // Berpindah gudang atau meninggalkan halaman membatalkan pencarian yang
  // sedang berjalan; hasilnya tidak lagi berlaku untuk apa yang tampil.
  useEffect(() => () => lookupAbortRef.current?.abort(), [wh]);

  const heatExportParams = useMemo(() => {
    const params = new URLSearchParams({ wh });
    if (basis !== "policy") params.set("view", basis);
    if (zoneQuery.trim()) params.set("q", zoneQuery.trim());
    if (statusFilter === "EMPTY") params.set("fill", "empty");
    else if (statusFilter === "OCCUPIED") params.set("fill", "occupied");
    else if (statusFilter !== "ALL") params.set("status", statusFilter);
    return params;
  }, [basis, statusFilter, wh, zoneQuery]);

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

        <div className="heat-search">
          <label>
            <span className="sr-only">{t("heat.searchZone")}</span>
            <input
              className="input"
              value={zoneQuery}
              onChange={(event) => setZoneQuery(event.target.value)}
              placeholder={t("heat.searchZone")}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void lookupSloc(slocQuery);
            }}
          >
            <label>
              <span className="sr-only">{t("slocx.searchLabel")}</span>
              <input
                className="input"
                value={slocQuery}
                onChange={(event) => {
                  setSlocQuery(event.target.value);
                  setSlocLookup("idle");
                }}
                placeholder={t("heat.searchSloc")}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <button type="submit" className="btn btn-sm" disabled={!slocQuery.trim() || slocLookup === "loading"}>
              {slocLookup === "loading" ? t("common.loading") : t("action.search")}
            </button>
          </form>
        </div>

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
          {slocLookup === "missing" && (
            <span style={{ color: "var(--st-critical-fg)" }}>
              {t("heat.initialSlocMissing").replace("{sloc}", slocQuery.trim().toUpperCase())}
            </span>
          )}
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
              <span><b className="num">{loading && zones.length === 0 ? "—" : totals.total.toLocaleString(locale)}</b> SLOC</span>
              <span aria-hidden="true">·</span>
              {/* Okupansi gabungan zona yang tampil, dihitung dengan rumus yang
                  sama dengan halaman Okupansi, sehingga kedua layar dapat
                  dibandingkan langsung alih-alih menyebut angka yang berbeda. */}
              <span title={`${t("common.filled")} ${totals.occupied.toLocaleString(locale)} · ${t("common.empty")} ${totals.empty.toLocaleString(locale)}`}>
                <b className="num">{loading && zones.length === 0 ? "—" : pctText(totals.occupancy)}</b>
                {" "}{t(`basis.${basis}`)}
              </span>
            </>
          )}
          <ExportExcelButton
            dataset="sloc"
            params={heatExportParams}
            disabled={loading && zones.length === 0}
            title={t("export.fullHint")}
          />
        </div>
      </div>

      <div className="heatmap-content">
        {loading && zones.length === 0 ? (
          <div className="heat-zone-cards" aria-busy="true" aria-label={t("heat.loading")}>
            {Array.from({ length: 4 }).map((_, index) => (
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
          <div className={`heat-zone-cards${loading ? " is-updating" : ""}`} aria-busy={loading}>
            {loading && <div className="heat-update-status" role="status">{t("heat.updating")}</div>}
            {visibleZones.map((zone) => (
              <HeatZoneGroup
                key={zone.zone}
                zone={zone}
                previews={previews}
                basis={basis}
                filter={statusFilter}
                locale={locale}
                labels={labels}
                t={t}
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
                <span className="eyebrow">{wh} · {selectedZone.zone} · {t("heat.fullZone")}</span>
                <h2 id="heat-zone-dialog-title">
                  {selectedZone.rack_zone}
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
                <ZoneLayout
                  aisles={zoneAisles}
                  basis={basis}
                  filter={statusFilter}
                  locale={locale}
                  label={`${selectedZone.rack_zone} SLOC`}
                  t={t}
                  onSelect={openCell}
                />
                {zoneLoading && zoneCells.length === 0 && (
                  <div className="heat-zone-loading">{t("common.loading")}</div>
                )}
                {!zoneLoading && zoneCells.length === 0 && (
                  <div className="heat-zone-loading">{t("heat.noCells")}</div>
                )}
              </div>
            )}

            <footer className="heat-zone-dialog-foot">
              <span className="num">
                {zoneCells.length
                  ? `${(zoneOffset + 1).toLocaleString(locale)}–${Math.min(zoneOffset + zoneCells.length, zoneTotal).toLocaleString(locale)} / ${zoneTotal.toLocaleString(locale)}`
                  : `0 / ${zoneTotal.toLocaleString(locale)}`}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {/* Dialog ini hanya memuat 600 sel sekaligus; ekspor mengambil
                    seluruh SLOC zona langsung dari server dalam satu berkas. */}
                <ExportExcelButton
                  dataset="sloc"
                  params={{
                    wh,
                    zone: selectedZone.zone,
                    rackZone: selectedZone.rack_zone,
                    ...(basis !== "policy" ? { view: basis } : {}),
                  }}
                  label={`${t("export.excel")} (${zoneTotal.toLocaleString(locale)})`}
                  title={t("export.fullHint")}
                />
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

            {/* Penyebut CBM adalah kapasitas EFEKTIF (max_cbm x utilisasi
                volume), sedangkan yang diketik admin di Pengaturan adalah
                max_cbm. Tanpa baris kedua ini, "max CBM 0,0336" terbaca
                "0,029" di layar dan tampak seolah konfigurasi tidak berlaku. */}
            <div className="heat-detail-metrics">
              <div>
                <span className="eyebrow">{t("heat.qty")}</span>
                <strong className="num">
                  {f.num(selectedCell.occ_qty)}/{selectedCell.qty_valid ? f.num(selectedCell.cap_qty) : "—"}
                </strong>
                <small className="metric-formula">{t("heat.capQtyNote")}</small>
              </div>
              <div>
                <span className="eyebrow">{t("heat.cbmEffective")}</span>
                <strong className="num">
                  {f.cbm(selectedCell.occ_cbm)}/{selectedCell.cbm_valid ? f.cbm(selectedCell.cap_cbm) : "—"}
                </strong>
                <small className="metric-formula num" title={t("heat.capCbmHint")}>
                  {selectedCell.cbm_valid
                    ? `${t("heat.capConfigured")} ${f.capCbm(selectedCell.cap_cbm_nominal)} × ${selectedCell.utilization_pct}%`
                    : t("heat.capUnknown")}
                </small>
              </div>
              <div>
                <span className="eyebrow">Bin</span>
                <strong>{selectedCell.occupied ? t("heat.binFilled") : t("heat.binEmpty")}</strong>
                {/* Basis kebijakan lokasi ini — yang menentukan status pada
                    tangga ambang, apa pun basis tampilan yang sedang dipilih. */}
                <small className="metric-formula" title={t("basis.hint")}>
                  {t("basis.label")}: {t(`basis.${selectedCell.basis}`)}
                </small>
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
                        <b className="num">{f.num(stockLine.qty)}</b>
                        <span>{f.cbm(stockLine.cbm)} m³</span>
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
                    <li key={movement.movement_uid}>
                      <div>
                        {/* Tipe kanonik, bukan teks aksi mentah: satu kegiatan
                            yang sama tidak boleh tampil dengan tiga ejaan
                            berbeda pada panel sesempit ini. Ejaan aslinya tetap
                            tersedia sebagai tooltip. */}
                        <strong title={movement.action_raw}>
                          {t(`mv.type.${movement.movement_type}`)}
                        </strong>
                        <span className="num">
                          {new Date(movement.at).toLocaleString(locale)}
                        </span>
                        <span className="num">
                          {movement.source_sloc ?? "—"} → {movement.destination_sloc ?? "—"}
                        </span>
                      </div>
                      <div className="heat-detail-list-value">
                        <b className={`num mvx-qty mvx-${movement.direction.toLowerCase()}`}>
                          {movement.direction === "OUT" ? "−" : movement.direction === "IN" ? "+" : ""}
                          {f.num(movement.qty)}
                        </b>
                        <span title={movement.product_name}>
                          {movement.operator || "—"}
                        </span>
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
