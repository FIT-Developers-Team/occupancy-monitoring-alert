// Pure helpers shared by server pages and client widgets.  Unlike lib/basis,
// this module does not read cookies and is safe to import into client code.
import type { BasisMode, OccupancyStatus } from "@/types";

type ViewRow = {
  pct: number;
  pct_qty: number | null;
  pct_cbm: number | null;
  pct_bin?: number;
  status: OccupancyStatus;
  status_qty?: OccupancyStatus | null;
  status_cbm?: OccupancyStatus | null;
  status_bin?: OccupancyStatus;
};

export function pickViewPct(row: ViewRow, mode: BasisMode): number | null {
  if (mode === "qty") return row.pct_qty;
  if (mode === "cbm") return row.pct_cbm;
  if (mode === "bin") return row.pct_bin ?? null;
  return row.pct;
}

/** Presentation status follows the selected view; alert evaluation stays policy-based. */
export function pickViewStatus(row: ViewRow, mode: BasisMode): OccupancyStatus {
  if (mode === "qty") return row.status_qty ?? row.status;
  if (mode === "cbm") return row.status_cbm ?? row.status;
  if (mode === "bin") return row.status_bin ?? row.status;
  return row.status;
}
