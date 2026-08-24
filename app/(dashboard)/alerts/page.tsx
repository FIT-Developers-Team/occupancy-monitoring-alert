import { listAlerts, eventsFor } from "@/lib/alerts/store";
import { currentUser, canWrite } from "@/lib/auth";
import { getRecipients } from "@/lib/config";
import { getLang, getT } from "@/lib/i18n";
import { formatters } from "@/lib/utils";
import Section from "@/components/ui/section";
import { SeverityBadge, AlertStatusBadge } from "@/components/ui/badges";
import RunTickButton from "@/components/domain/run-tick-button";
import AlertBoard, { type AlertEvent } from "@/components/domain/alert-board";
import ExportExcelButton from "@/components/domain/export-excel-button";
import PageHeader from "@/components/ui/page-header";
import { pageTitle } from "@/lib/page-metadata";

export const dynamic = "force-dynamic";
export const generateMetadata = pageTitle("nav.alerts");

export default async function AlertsPage(
  { searchParams }: { searchParams: Promise<{ id?: string }> }
) {
  const { id } = await searchParams;
  const [user, t, lang] = await Promise.all([currentUser(), getT(), getLang()]);
  const f = formatters(lang);
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
          initialId={id} exportGroup="open" />
      </Section>

      <Section eyebrow={`${acked.length}`} title={t("alert.ack")}>
        <AlertBoard alerts={acked} events={evMap} writable={writable} levels={levels}
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
                  <span className="eyebrow">{a.resolved_by ?? "—"} · {f.dateTime(a.resolved_at)}</span>
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
