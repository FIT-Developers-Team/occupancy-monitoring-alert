import type { OccupancyStatus } from "@/types";
import { STATUS_COLOR } from "@/lib/status-tone";

/** Signature FIT: bar okupansi dengan tick ambang — aturan terbaca langsung di bar. */
export default function OccupancyBar({
  pct, status, thresholds, label,
}: {
  pct: number;
  status: OccupancyStatus;
  thresholds?: { monitor: number; warning: number; critical: number };
  label?: string;
}) {
  const t = thresholds ?? { monitor: 70, warning: 85, critical: 95 };
  const width = Math.max(0, Math.min(100, pct));
  return (
    <div
      className="occ-track"
      role="meter"
      aria-label={label ?? "Occupancy"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.max(0, Math.min(100, pct))}
      aria-valuetext={`${pct}%`}
    >
      <div className="occ-fill" style={{ width: `${width}%`, background: STATUS_COLOR[status] }} />
      {( [t.monitor, t.warning, t.critical] as const ).map((tick, i) => (
        <span key={i} className={`occ-tick ${pct >= tick ? "hot" : ""}`}
          style={{ left: `${tick}%` }} />
      ))}
    </div>
  );
}
