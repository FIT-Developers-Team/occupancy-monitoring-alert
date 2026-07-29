import type { CSSProperties, ReactNode } from "react";

export default function KpiCard({
  label, value, sub, tone,
}: {
  label: string; value: ReactNode; sub?: ReactNode;
  tone?: "normal" | "monitor" | "warning" | "critical" | "breach" | "accent" | "teal";
}) {
  const toneColor =
    tone === "accent" ? "var(--accent)"
    : tone === "teal" ? "#14B8A6"
    : tone ? `var(--st-${tone}-fg)` : "var(--text-muted)";
  return (
    <div className="metric-card" style={{ "--metric-tone": toneColor } as CSSProperties}>
      <div className="metric-label">
        <i aria-hidden="true" />
        <span>{label}</span>
      </div>
      <div className="metric-value num">{value}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  );
}
