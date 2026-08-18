import { listAlerts, eventsFor } from "@/lib/alerts/store";
import { currentUser, canWrite } from "@/lib/auth";
import { getRecipients } from "@/lib/config";
import { getT } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/utils";
import Section from "@/components/ui/section";
import { SeverityBadge, AlertStatusBadge } from "@/components/ui/badges";
import RunTickButton from "@/components/domain/run-tick-button";
import AlertBoard, { type AlertEvent } from "@/components/domain/alert-board";
import ExportExcelButton from "@/components/domain/export-excel-button";
import PageHeader from "@/components/ui/page-header";

export const dynamic = "force-dynamic";

const RULE_HINT_IDS = [
  "R01", "R02", "R03", "R04", "R05", "R06", "R07",
  "R08", "R09", "R10", "R11", "R12", "R13", "R14",
] as const;
const OCCUPANCY_RULE_IDS = [
  "OCC-MONITOR", "OCC-WARNING", "OCC-CRITICAL", "OCC-BREACH", "OCC-ZONE-BREACH",
] as const;

export default async function AlertsPage(
  { searchParams }: { searchParams: Promise<{ id?: string }> }
) {
  const { id } = await searchParams;
  const [user, t] = await Promise.all([currentUser(), getT()]);
  const writable = user ? canWrite(user.role) : false;
  const cfg = getRecipients();
  const levels: Record<number, string> = {};
  for (const l of cfg.levels) levels[l.level] = `L${l.level} · ${l.name}`;

  const [open, acked, closed] = await Promise.all([
    listAlerts({ status: ["NEW", "NOTIFIED"], limit: 200 }),
    listAlerts({ status: ["ACKNOWLEDGED"], limit: 100 }),
    listAlerts({ status: ["RESOLVED", "FALSE_POSITIVE"], limit: 30 }),
  ]);
  const evs = await eventsFor([...open, ...acked].map((a) => a.alert_id));
  const evMap: Record<string, AlertEvent[]> = {};
  for (const e of evs) (evMap[e.alert_id] ??= []).push(e as AlertEvent);

  const hints: Record<string, { reason: string; action: string }> = {};
  for (const ruleId of [...RULE_HINT_IDS, ...OCCUPANCY_RULE_IDS]) {
    hints[ruleId] = {
      reason: t(`alert.rule.${ruleId}.reason`),
      action: t(`alert.rule.${ruleId}.action`),
    };
  }
  const runtimeRuleIds = new Set([
    ...open.map((alert) => alert.rule_id),
    ...acked.map((alert) => alert.rule_id),
  ]);
  for (const ruleId of runtimeRuleIds) {
    hints[ruleId] ??= {
      reason: t("alert.rule.fallback.reason").replace("{rule}", ruleId),
      action: t("alert.rule.fallback.action"),
    };
  }

  return (
    <div className="dashboard-page">
      <PageHeader
        eyebrow={`${open.length} ${t("alert.open").toLowerCase()} · ${acked.length} ${t("alert.ack").toLowerCase()}`}
        title={t("alert.title")}
        actions={
          <>
            <ExportExcelButton dataset="alerts" params={{ group: "all" }}
              label={`${t("export.excel")} · ${t("alert.title")}`} />
            <RunTickButton enabled={writable} />
          </>
        }
      />

      <Section eyebrow={`${open.length}`} title={t("alert.open")}>
        <AlertBoard alerts={open} events={evMap} writable={writable} levels={levels}
          ruleHints={hints} initialId={id} exportGroup="open" />
      </Section>

      <Section eyebrow={`${acked.length}`} title={t("alert.ack")}>
        <AlertBoard alerts={acked} events={evMap} writable={writable} levels={levels} ruleHints={hints}
          exportGroup="acknowledged" />
      </Section>

      <Section eyebrow="30" title={t("alert.resolved")}
        action={<ExportExcelButton dataset="alerts" params={{ group: "closed" }} />}>
        {closed.length === 0 ? (
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>{t("common.none")}</p>
        ) : (
          <ul className="space-y-1.5">
            {closed.map((a) => (
              <li key={a.alert_id} className="flex flex-wrap items-center gap-2 text-[12px]">
                <SeverityBadge severity={a.severity} />
                <span className="num font-semibold">{a.warehouse_code}</span>
                <span className="truncate">{a.title}</span>
                <span className="ml-auto flex items-center gap-2">
                  <span className="eyebrow">{a.resolved_by ?? "—"} · {fmtDateTime(a.resolved_at)}</span>
                  <AlertStatusBadge status={a.status} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
