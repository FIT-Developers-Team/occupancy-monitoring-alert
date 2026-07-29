// Query helpers untuk alert lifecycle (state DB).
import { stateQuery, stateExec, uid } from "@/lib/db";
import type { Alert, Severity } from "@/types";

export interface AlertFilters {
  status?: string[];
  severity?: Severity;
  warehouse?: string;
  rule?: string;
  limit?: number;
}

export async function listAlerts(f: AlertFilters = {}): Promise<Alert[]> {
  const cond: string[] = [];
  const params: unknown[] = [];
  if (f.status?.length) {
    cond.push(`status IN (${f.status.map(() => "?").join(",")})`);
    params.push(...f.status);
  }
  if (f.severity) { cond.push("severity = ?"); params.push(f.severity); }
  if (f.warehouse) { cond.push("warehouse_code = ?"); params.push(f.warehouse); }
  if (f.rule) { cond.push("rule_id = ?"); params.push(f.rule); }
  const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
  const limit = Math.min(500, Math.max(1, f.limit ?? 200));
  return stateQuery<Alert>(
    `SELECT * FROM alerts ${where}
     ORDER BY CASE severity
        WHEN 'EMERGENCY' THEN 0 WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2
        WHEN 'WARNING' THEN 3 ELSE 4 END,
       updated_at DESC
     LIMIT ${limit}`,
    params
  );
}

export async function activeCountsBySeverity(): Promise<Record<string, number>> {
  const rows = await stateQuery<{ severity: string; n: number }>(
    `SELECT severity, count(*)::INT n FROM alerts
     WHERE status IN ('NEW','NOTIFIED','ACKNOWLEDGED') GROUP BY 1`
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.severity] = r.n;
  return out;
}

export async function getAlert(alertId: string): Promise<Alert | null> {
  const r = await stateQuery<Alert>("SELECT * FROM alerts WHERE alert_id = ?", [alertId]);
  return r[0] ?? null;
}

export async function eventsFor(alertIds: string[]) {
  if (!alertIds.length) return [];
  return stateQuery<{ id: string; alert_id: string; at: string; actor: string; action: string; note: string | null }>(
    `SELECT * FROM alert_events WHERE alert_id IN (${alertIds.map(() => "?").join(",")})
     ORDER BY "at" ASC`,
    alertIds
  );
}

export async function transitionAlert(
  alertId: string,
  action: "ACKNOWLEDGED" | "RESOLVED" | "FALSE_POSITIVE",
  actor: string,
  note: string
): Promise<Alert | null> {
  const a = await getAlert(alertId);
  if (!a) return null;
  if (a.status === "RESOLVED" || a.status === "FALSE_POSITIVE") return a;

  if (action === "ACKNOWLEDGED") {
    await stateExec(
      `UPDATE alerts SET status='ACKNOWLEDGED', acknowledged_by=?, acknowledged_at=now(),
          next_escalation_at=NULL, updated_at=now() WHERE alert_id=?`,
      [actor, alertId]
    );
  } else {
    await stateExec(
      `UPDATE alerts SET status=?, resolved_by=?, resolved_at=now(),
          resolution_note=?, next_escalation_at=NULL, updated_at=now() WHERE alert_id=?`,
      [action, actor, note || null, alertId]
    );
  }
  await stateExec(
    "INSERT INTO alert_events VALUES (?, ?, now(), ?, ?, ?)",
    [uid("evt-"), alertId, actor, action, note || null]
  );
  return getAlert(alertId);
}

export async function ruleCounts(hoursBack = 24 * 7) {
  return stateQuery<{ rule_name: string; n: number }>(
    `SELECT rule_name, count(*)::INT n FROM alerts
     WHERE created_at >= now() - INTERVAL ${Math.floor(hoursBack)} HOUR
     GROUP BY 1 ORDER BY 2 DESC`
  );
}

export async function notificationLog(limit = 50) {
  return stateQuery(
    `SELECT * FROM notification_log ORDER BY "at" DESC LIMIT ${Math.min(200, limit)}`
  );
}

export async function auditLog(limit = 100) {
  return stateQuery(
    `SELECT * FROM audit_log ORDER BY "at" DESC LIMIT ${Math.min(300, limit)}`
  );
}
