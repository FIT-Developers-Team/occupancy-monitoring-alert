import { fmtDateTime } from "@/lib/utils";

export interface AlertEvent { id: string; at: string; actor: string; action: string; note: string | null }

const ACTION_LABEL: Record<string, string> = {
  CREATED: "Dibuat", ESCALATED: "Eskalasi", ACKNOWLEDGED: "Di-ack",
  RESOLVED: "Selesai", FALSE_POSITIVE: "False Positive", AUTO_RESOLVED: "Auto-selesai",
};

export default function EscalationTimeline({ events }: { events: AlertEvent[] }) {
  if (!events.length) return null;
  return (
    <ol className="space-y-2">
      {events.map((e) => (
        <li key={e.id} className="flex gap-2.5 text-[11.5px]">
          <span className="mt-1 h-2 w-2 flex-none rounded-full"
            style={{ background: e.action === "ESCALATED" ? "var(--st-warning-fg)" : "var(--accent)" }} />
          <div>
            <span className="font-semibold">{ACTION_LABEL[e.action] ?? e.action}</span>
            <span style={{ color: "var(--text-muted)" }}> · {e.actor} · {fmtDateTime(e.at)}</span>
            {e.note && <div style={{ color: "var(--text-muted)" }}>{e.note}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
