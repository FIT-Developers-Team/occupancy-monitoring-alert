import { thresholdsFor } from "@/lib/config";
import type { OccupancyStatus } from "@/types";

/** Map an occupancy % to the FIT status ladder using per-warehouse thresholds. */
export function statusFor(pct: number, warehouseCode: string): OccupancyStatus {
  const t = thresholdsFor(warehouseCode);
  if (pct >= t.breach) return "BREACH";
  if (pct >= t.critical) return "CRITICAL";
  if (pct >= t.warning) return "WARNING";
  if (pct >= t.monitor) return "MONITOR";
  return "NORMAL";
}

/** Ladder level as integer (0..4) — used by the hysteresis engine. */
export function ladderLevel(pct: number, warehouseCode: string): number {
  return ["NORMAL", "MONITOR", "WARNING", "CRITICAL", "BREACH"].indexOf(
    statusFor(pct, warehouseCode)
  );
}
