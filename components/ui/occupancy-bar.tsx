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
  // Cadangan terakhir. Setiap pemanggil seharusnya mengirim ambang gudangnya
  // sendiri: PGS, misalnya, disetel 70/82/92, dan tanda pada bar yang berhenti
  // di 70/85/95 akan bertentangan dengan lencana status di sebelahnya.
  const t = thresholds ?? { monitor: 70, warning: 85, critical: 95 };
  const width = Math.max(0, Math.min(100, pct));
  // Isi bar berhenti di 100%, tetapi nilainya tidak. Mengunci aria-valuemax di
  // 100 membuat pembaca layar melaporkan lokasi 117% sebagai "penuh" — sama
  // dengan lokasi yang tepat pas di kapasitas, padahal itulah perbedaan antara
  // Critical dan Breach.
  const ceiling = Math.max(100, Math.ceil(pct));
  return (
    <div
      className="occ-track"
      role="meter"
      aria-label={label ?? "Occupancy"}
      aria-valuemin={0}
      aria-valuemax={ceiling}
      aria-valuenow={Math.max(0, pct)}
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
