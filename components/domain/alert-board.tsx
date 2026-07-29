"use client";
// Papan alert per gudang + pop-up detail (sebab, dampak, tindakan, riwayat).
import { useMemo, useState } from "react";
import type { Alert } from "@/types";
import { fmtDateTime } from "@/lib/utils";
import { useT } from "@/lib/i18n-client";
import { SeverityBadge, AlertStatusBadge } from "@/components/ui/badges";
import AlertActions from "@/components/domain/alert-actions";

export interface AlertEvent {
  id: string; alert_id: string; at: string; actor: string; action: string; note: string | null;
}

export default function AlertBoard({
  alerts, events, writable, levels, ruleHints, initialId,
}: {
  alerts: Alert[];
  events: Record<string, AlertEvent[]>;
  writable: boolean;
  levels: Record<number, string>;
  ruleHints: Record<string, { reason: string; action: string }>;
  initialId?: string;
}) {
  const { t } = useT();
  const [wh, setWh] = useState<string>("");
  const [sel, setSel] = useState<Alert | null>(
    initialId ? alerts.find((a) => a.alert_id === initialId) ?? null : null);

  const whs = useMemo(
    () => [...new Set(alerts.map((a) => a.warehouse_code))].sort(), [alerts]);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of alerts) m[a.warehouse_code] = (m[a.warehouse_code] ?? 0) + 1;
    return m;
  }, [alerts]);
  const shown = wh ? alerts.filter((a) => a.warehouse_code === wh) : alerts;
  const hint = (a: Alert) => ruleHints[a.rule_id] ?? { reason: a.detail, action: "" };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <button className={`chip ${wh === "" ? "chip-accent" : ""}`} onClick={() => setWh("")}>
          {t("common.allWarehouses")} {alerts.length}
        </button>
        {whs.map((w) => (
          <button key={w} className={`chip ${wh === w ? "chip-accent" : ""}`} onClick={() => setWh(w)}>
            {w} {counts[w]}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="py-6 text-center text-xs" style={{ color: "var(--text-muted)" }}>{t("common.none")}</p>
      ) : (
        <ul className="alert-list">
          {shown.map((a) => (
            <li key={a.alert_id}>
              <button className="alert-row"
                onClick={() => setSel(a)}>
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={a.severity} />
                  <span className="num text-[13px] font-semibold">{a.warehouse_code}</span>
                  {a.sloc_code && <span className="chip num">{a.sloc_code}</span>}
                  <span className="ml-auto flex items-center gap-2">
                    <span className="eyebrow">{levels[a.escalation_level] ?? `L${a.escalation_level}`}</span>
                    <AlertStatusBadge status={a.status} />
                  </span>
                </div>
                <div className="mt-1 text-[12.5px] font-semibold">{a.title}</div>
                <div className="truncate text-[11px]" style={{ color: "var(--text-muted)" }}>
                  {hint(a).reason}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {sel && (
        <div className="anim-fade fixed inset-0 z-50 flex items-end justify-center p-0 md:items-center md:p-4"
          style={{ background: "rgba(8,12,24,0.55)" }} onMouseDown={() => setSel(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setSel(null);
          }}>
          <div
            className="card anim-in w-full max-w-lg overflow-hidden"
            role="dialog"
            aria-modal="true"
            aria-labelledby="alert-detail-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-4"
              style={{ borderBottom: "1px solid var(--border)" }}>
              <div className="min-w-0">
                <div className="eyebrow">{t("alert.detail")} · {sel.rule_id}</div>
                <h3 id="alert-detail-title" className="panel-title truncate">{sel.title}</h3>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setSel(null)}
                aria-label={t("action.close")}>{t("action.close")}</button>
            </div>
            <div className="space-y-3 px-4 py-3 text-[12.5px]">
              <div className="flex flex-wrap items-center gap-2">
                <SeverityBadge severity={sel.severity} />
                <AlertStatusBadge status={sel.status} />
                <span className="chip num">{sel.warehouse_code}</span>
                {sel.zone && <span className="chip">{sel.zone}</span>}
                {sel.sloc_code && <span className="chip num">{sel.sloc_code}</span>}
                {sel.sku && <span className="chip num">{t("common.skuNo")} {sel.sku}</span>}
              </div>
              <div>
                <div className="eyebrow mb-1">{t("alert.reason")}</div>
                <p style={{ color: "var(--text-muted)" }}>{hint(sel).reason}</p>
              </div>
              {hint(sel).action && (
                <div>
                  <div className="eyebrow mb-1">{t("alert.action")}</div>
                  <p style={{ color: "var(--text-muted)" }}>{hint(sel).action}</p>
                </div>
              )}
              <div className="alert-detail-metrics">
                <div>
                  <div className="eyebrow">{t("alert.occurrences")}</div>
                  <div className="num font-semibold">{sel.occurrences}×</div>
                </div>
                <div>
                  <div className="eyebrow">{t("alert.escalation")}</div>
                  <div className="text-[12px] font-semibold">{levels[sel.escalation_level] ?? `L${sel.escalation_level}`}</div>
                </div>
                <div>
                  <div className="eyebrow">{t("common.time")}</div>
                  <div className="num text-[11px] font-semibold">{fmtDateTime(sel.created_at)}</div>
                </div>
              </div>
              {(events[sel.alert_id] ?? []).length > 0 && (
                <div>
                  <div className="eyebrow mb-1">{t("alert.escalation")}</div>
                  <ul className="space-y-1">
                    {(events[sel.alert_id] ?? []).slice(0, 6).map((e) => (
                      <li key={e.id} className="flex justify-between gap-2 text-[11px]"
                        style={{ color: "var(--text-muted)" }}>
                        <span>{e.action}{e.note ? ` — ${e.note}` : ""}</span>
                        <span className="num shrink-0">{fmtDateTime(e.at)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 px-4 py-3" style={{ borderTop: "1px solid var(--border)" }}>
              <AlertActions alertId={sel.alert_id} status={sel.status} canWrite={writable} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
