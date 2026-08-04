// Alert engine fase saat ini:
//   1. Hanya breach okupansi pada tingkat ZONA yang membuat alert.
//   2. Hysteresis mencegah alert berulang saat nilai berosilasi dekat ambang.
//   3. Alert pulih otomatis setelah zona turun di bawah breach - buffer.
//   4. Alert tanpa acknowledgement naik mengikuti level dinamis.
// Rule berbasis movement/stok sengaja tidak dijalankan sampai datanya tersedia.
import { stateExec, stateQuery, uid } from "@/lib/db";
import { getRecipients, thresholdsFor } from "@/lib/config";
import { getZoneSummary } from "@/lib/queries";
import { dispatchToLevel, type DispatchResult } from "@/lib/notify/dispatch";
import { audit } from "@/lib/audit";
import type { Alert, Severity, ZoneSummary } from "@/types";

const OPEN = "('NEW','NOTIFIED','ACKNOWLEDGED')";
const ZONE_BREACH_RULE = "OCC-ZONE-BREACH";

export interface TickResult {
  created: number;
  updated: number;
  auto_resolved: number;
  escalated: number;
  notified: number;
  notification_failed: number;
  notification_skipped: number;
  evaluated_rules: string[];
}

interface Violation {
  rule_id: string;
  rule_name: string;
  severity: Severity;
  warehouse_code: string;
  zone: string | null;
  sloc_code: string | null;
  sku: string | null;
  title: string;
  detail: string;
  dedup_key: string;
}

async function getState(key: string): Promise<string | null> {
  const rows = await stateQuery<{ value: string }>(
    "SELECT value FROM rule_state WHERE key = ?",
    [key],
  );
  return rows[0]?.value ?? null;
}

async function setState(key: string, value: string): Promise<void> {
  await stateExec(
    `INSERT INTO rule_state VALUES (?, 'v', ?, now())
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [key, value],
  );
}

async function openAlertByKey(dedupKey: string): Promise<Alert | null> {
  const rows = await stateQuery<Alert>(
    `SELECT * FROM alerts WHERE dedup_key = ? AND status IN ${OPEN}
     ORDER BY created_at DESC LIMIT 1`,
    [dedupKey],
  );
  return rows[0] ?? null;
}

function startLevelFor(severity: Severity): number {
  const config = getRecipients();
  return config.severity_start_level[severity] ?? 1;
}

function nextEscalationDelayMin(level: number): number | null {
  const config = getRecipients();
  return config.levels.find((item) => item.level === level + 1)?.delay_minutes ?? null;
}

function mergeDispatch(result: TickResult, dispatch: DispatchResult): void {
  result.notified += dispatch.sent;
  result.notification_failed += dispatch.failed;
  result.notification_skipped += dispatch.skipped;
}

async function insertAlert(violation: Violation): Promise<Alert> {
  const id = uid("alr-");
  const level = startLevelFor(violation.severity);
  const delay = nextEscalationDelayMin(level);
  await stateExec(
    `INSERT INTO alerts VALUES (
       ?, now(), now(), ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW', ?, 1,
       NULL, NULL, NULL, NULL, NULL, ?, ${delay === null ? "NULL" : `now() + INTERVAL ${delay} MINUTE`}
     )`,
    [
      id,
      violation.rule_id,
      violation.rule_name,
      violation.severity,
      violation.warehouse_code,
      violation.zone,
      violation.sloc_code,
      violation.sku,
      violation.title,
      violation.detail,
      violation.dedup_key,
      level,
    ],
  );
  await stateExec(
    "INSERT INTO alert_events VALUES (?, ?, now(), 'system', 'CREATED', ?)",
    [uid("evt-"), id, violation.title],
  );
  const rows = await stateQuery<Alert>("SELECT * FROM alerts WHERE alert_id = ?", [id]);
  return rows[0];
}

const SEVERITY_ORDER: Severity[] = ["INFO", "WARNING", "HIGH", "CRITICAL", "EMERGENCY"];

async function bumpAlert(existing: Alert, violation: Violation): Promise<Alert> {
  // Never silently downgrade a live alert, and when it gets worse move it to
  // the tier that severity is configured to start at. Without this an alert
  // that opened as WARNING (tier 1) but escalated to CRITICAL kept notifying
  // tier 1 only, because severity_start_level was applied at creation alone.
  const severity = SEVERITY_ORDER.indexOf(violation.severity) > SEVERITY_ORDER.indexOf(existing.severity)
    ? violation.severity
    : existing.severity;
  const level = Math.max(existing.escalation_level, startLevelFor(severity));
  const delay = nextEscalationDelayMin(level);

  await stateExec(
    `UPDATE alerts SET occurrences = occurrences + 1, updated_at = now(),
        severity = ?, title = ?, detail = ?, escalation_level = ?,
        next_escalation_at = ${delay === null ? "NULL" : `now() + INTERVAL ${delay} MINUTE`}
     WHERE alert_id = ?`,
    [severity, violation.title, violation.detail, level, existing.alert_id],
  );
  if (level > existing.escalation_level) {
    await stateExec(
      "INSERT INTO alert_events VALUES (?, ?, now(), 'system', 'ESCALATED', ?)",
      [uid("evt-"), existing.alert_id, `Severity naik ke ${severity} — langsung ke level ${level}`],
    );
  }
  return {
    ...existing,
    severity,
    title: violation.title,
    detail: violation.detail,
    escalation_level: level,
    occurrences: existing.occurrences + 1,
  };
}

async function systemResolve(alertId: string, note: string): Promise<void> {
  await stateExec(
    `UPDATE alerts SET status = 'RESOLVED', resolved_by = 'system',
        resolved_at = now(), resolution_note = ?, next_escalation_at = NULL, updated_at = now()
     WHERE alert_id = ?`,
    [note, alertId],
  );
  await stateExec(
    "INSERT INTO alert_events VALUES (?, ?, now(), 'system', 'AUTO_RESOLVED', ?)",
    [uid("evt-"), alertId, note],
  );
}

function zoneViolation(zone: ZoneSummary): Violation {
  const threshold = thresholdsFor(zone.wh).breach;
  const capacity = zone.basis === "qty"
    ? `${Math.round(zone.occ_qty).toLocaleString("id-ID")} / ${Math.round(zone.cap_qty).toLocaleString("id-ID")} unit`
    : `${zone.occ_cbm.toLocaleString("id-ID")} / ${zone.cap_cbm.toLocaleString("id-ID")} m³`;
  return {
    rule_id: ZONE_BREACH_RULE,
    rule_name: "Breach Okupansi Zona",
    severity: "CRITICAL",
    warehouse_code: zone.wh,
    zone: zone.zone,
    sloc_code: null,
    sku: null,
    title: `Zona ${zone.zone} di ${zone.wh} mencapai ${zone.pct}%`,
    detail: `Okupansi zona melewati ambang breach ${threshold}% pada basis ${zone.basis.toUpperCase()}. Terisi ${capacity}; ${zone.sloc_occupied.toLocaleString("id-ID")} lokasi terisi dan ${zone.sloc_empty.toLocaleString("id-ID")} lokasi kosong. Tahan atau alihkan inbound zona ini dan prioritaskan outbound.`,
    dedup_key: `${ZONE_BREACH_RULE}:${zone.wh}:${zone.zone}`,
  };
}

async function resolveTriggersDisabledForCurrentPhase(result: TickResult): Promise<void> {
  const rows = await stateQuery<{ count: number }>(
    `SELECT count(*)::INT AS count FROM alerts WHERE status IN ${OPEN} AND rule_id <> ?`,
    [ZONE_BREACH_RULE],
  );
  const count = rows[0]?.count ?? 0;
  if (!count) return;
  // One bulk write avoids tens of thousands of DuckDB round-trips when an
  // existing installation switches from legacy stock rules to zone-only mode.
  await stateExec(
    `UPDATE alerts SET status = 'RESOLVED', resolved_by = 'system', resolved_at = now(),
        resolution_note = 'Trigger dinonaktifkan pada fase saat ini; hanya breach okupansi per zona yang aktif.',
        next_escalation_at = NULL, updated_at = now()
     WHERE status IN ${OPEN} AND rule_id <> ?`,
    [ZONE_BREACH_RULE],
  );
  result.auto_resolved += count;
}

async function evaluateZoneBreaches(result: TickResult): Promise<void> {
  const zones = await getZoneSummary();
  result.evaluated_rules.push(ZONE_BREACH_RULE);

  for (const zone of zones) {
    const threshold = thresholdsFor(zone.wh);
    const stateKey = `occ-zone-breach:${zone.wh}:${zone.zone}`;
    const armed = (await getState(stateKey)) === "1";
    const breaching = zone.pct >= threshold.breach;
    const dedupKey = `${ZONE_BREACH_RULE}:${zone.wh}:${zone.zone}`;

    if (breaching && !armed) {
      const violation = zoneViolation(zone);
      const existing = await openAlertByKey(dedupKey);
      const alert = existing
        ? await bumpAlert(existing, violation)
        : await insertAlert(violation);
      if (existing) result.updated++; else result.created++;
      mergeDispatch(result, await dispatchToLevel(alert, alert.escalation_level));
      await setState(stateKey, "1");
      continue;
    }

    if (armed && zone.pct < threshold.breach - threshold.hysteresis_buffer) {
      await setState(stateKey, "0");
      const open = await openAlertByKey(dedupKey);
      if (open) {
        await systemResolve(
          open.alert_id,
          `Okupansi zona ${zone.wh}/${zone.zone} turun ke ${zone.pct}% (di bawah ${threshold.breach}% - buffer ${threshold.hysteresis_buffer}%).`,
        );
        result.auto_resolved++;
      }
    }
  }
}

async function evaluateEscalation(result: TickResult): Promise<void> {
  const due = await stateQuery<Alert>(
    `SELECT * FROM alerts
     WHERE status IN ('NEW','NOTIFIED')
       AND next_escalation_at IS NOT NULL AND next_escalation_at <= now()`,
  );
  const config = getRecipients();
  const maxLevel = Math.max(...config.levels.map((level) => level.level));

  for (const alert of due) {
    if (alert.escalation_level >= maxLevel) {
      await stateExec("UPDATE alerts SET next_escalation_at = NULL WHERE alert_id = ?", [alert.alert_id]);
      continue;
    }
    const newLevel = alert.escalation_level + 1;
    const delay = nextEscalationDelayMin(newLevel);
    await stateExec(
      `UPDATE alerts SET escalation_level = ?, updated_at = now(), status = 'NOTIFIED',
          next_escalation_at = ${delay === null ? "NULL" : `now() + INTERVAL ${delay} MINUTE`}
       WHERE alert_id = ?`,
      [newLevel, alert.alert_id],
    );
    const levelName = config.levels.find((level) => level.level === newLevel)?.name ?? `L${newLevel}`;
    await stateExec(
      "INSERT INTO alert_events VALUES (?, ?, now(), 'system', 'ESCALATED', ?)",
      [uid("evt-"), alert.alert_id, `Naik ke ${levelName} (tanpa acknowledgement)`],
    );
    mergeDispatch(
      result,
      await dispatchToLevel(
        { ...alert, escalation_level: newLevel, status: "NOTIFIED" },
        newLevel,
        `ESKALASI ${levelName}`,
      ),
    );
    result.escalated++;
  }
}

async function runTickInternal(actor: string): Promise<TickResult> {
  const result: TickResult = {
    created: 0,
    updated: 0,
    auto_resolved: 0,
    escalated: 0,
    notified: 0,
    notification_failed: 0,
    notification_skipped: 0,
    evaluated_rules: [],
  };
  await resolveTriggersDisabledForCurrentPhase(result);
  await evaluateZoneBreaches(result);
  await evaluateEscalation(result);
  await audit(actor, "TICK", "alert_engine", undefined, result);
  return result;
}

// A manual click and scheduler request can arrive together. Serialise them in
// this process so the read-then-insert dedup flow never emits duplicate alerts.
let activeTick: Promise<TickResult> | null = null;

export async function runTick(actor: string): Promise<TickResult> {
  if (activeTick) return activeTick;
  activeTick = runTickInternal(actor).finally(() => { activeTick = null; });
  return activeTick;
}
