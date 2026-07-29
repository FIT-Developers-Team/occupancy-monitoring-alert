// ---------------------------------------------------------------------------
// Alert engine — dipanggil oleh /api/cron/tick (cron 5 menit) atau tombol
// "Evaluasi sekarang" di Alert Center.
//
//   1. Okupansi per gudang → tangga severity dengan HYSTERESIS anti-flapping
//      (naik saat menembus ambang, turun hanya setelah melewati ambang − buffer;
//      94.8 → 95.1 → 94.9 tidak menghasilkan tiga alert).
//   2. Rule stok (R03/R11/R13/R14) atas kondisi snapshot terbaru.
//   3. Auto-resolve saat kondisi pulih pada evaluasi berikutnya.
//   4. Eskalasi: alert terbuka tanpa Ack melewati timer → naik level, notifikasi
//      tier berikutnya (matriks config/recipients.json).
// ---------------------------------------------------------------------------
import { stateExec, stateQuery, uid } from "@/lib/db";
import { getRules, getRecipients, thresholdsFor } from "@/lib/config";
import { getWarehouseSummaries } from "@/lib/queries";
import { RULE_EVALUATORS, STATE_RULES, type Violation } from "@/lib/alerts/rules";
import { dispatchToLevel } from "@/lib/notify/dispatch";
import { audit } from "@/lib/audit";
import type { Alert, Severity } from "@/types";

const OPEN = "('NEW','NOTIFIED','ACKNOWLEDGED')";

export interface TickResult {
  created: number;
  updated: number;
  auto_resolved: number;
  escalated: number;
  notified: number;
  evaluated_rules: string[];
}

// ---- helpers ---------------------------------------------------------------
async function getState(key: string): Promise<string | null> {
  const r = await stateQuery<{ value: string }>(
    "SELECT value FROM rule_state WHERE key = ?", [key]
  );
  return r[0]?.value ?? null;
}
async function setState(key: string, value: string): Promise<void> {
  await stateExec(
    `INSERT INTO rule_state VALUES (?, 'v', ?, now())
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [key, value]
  );
}

async function openAlertByKey(dedupKey: string): Promise<Alert | null> {
  const r = await stateQuery<Alert>(
    `SELECT * FROM alerts WHERE dedup_key = ? AND status IN ${OPEN}
     ORDER BY created_at DESC LIMIT 1`,
    [dedupKey]
  );
  return r[0] ?? null;
}

function startLevelFor(sev: Severity): number {
  const cfg = getRecipients();
  return cfg.severity_start_level[sev] ?? 1;
}
function nextEscalationDelayMin(level: number): number | null {
  const cfg = getRecipients();
  const next = cfg.levels.find((l) => l.level === level + 1);
  return next ? next.delay_minutes : null;
}

async function insertAlert(v: Violation): Promise<Alert> {
  const id = uid("alr-");
  const level = startLevelFor(v.severity);
  const delay = nextEscalationDelayMin(level);
  await stateExec(
    `INSERT INTO alerts VALUES (
       ?, now(), now(), ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW', ?, 1,
       NULL, NULL, NULL, NULL, NULL, ?, ${delay === null ? "NULL" : `now() + INTERVAL ${delay} MINUTE`}
     )`,
    [
      id, v.rule_id, v.rule_name, v.severity, v.warehouse_code, v.zone,
      v.sloc_code, v.sku, v.title, v.detail, v.dedup_key, level,
    ]
  );
  await stateExec(
    "INSERT INTO alert_events VALUES (?, ?, now(), 'system', 'CREATED', ?)",
    [uid("evt-"), id, v.title]
  );
  const rows = await stateQuery<Alert>("SELECT * FROM alerts WHERE alert_id = ?", [id]);
  return rows[0];
}

async function bumpAlert(existing: Alert, v: Violation): Promise<void> {
  // Naikkan severity bila violation baru lebih tinggi; jangan pernah turunkan.
  const order = ["INFO", "WARNING", "HIGH", "CRITICAL", "EMERGENCY"];
  const sev =
    order.indexOf(v.severity) > order.indexOf(existing.severity)
      ? v.severity
      : existing.severity;
  await stateExec(
    `UPDATE alerts SET occurrences = occurrences + 1, updated_at = now(),
        severity = ?, title = ?, detail = ? WHERE alert_id = ?`,
    [sev, v.title, v.detail, existing.alert_id]
  );
}

async function systemResolve(alertId: string, note: string): Promise<void> {
  await stateExec(
    `UPDATE alerts SET status = 'RESOLVED', resolved_by = 'system',
        resolved_at = now(), resolution_note = ?, updated_at = now()
     WHERE alert_id = ?`,
    [note, alertId]
  );
  await stateExec(
    "INSERT INTO alert_events VALUES (?, ?, now(), 'system', 'AUTO_RESOLVED', ?)",
    [uid("evt-"), alertId, note]
  );
}

// ---- 1) occupancy ladder with hysteresis -----------------------------------
const LADDER: { key: "monitor" | "warning" | "critical" | "breach"; sev: Severity }[] = [
  { key: "monitor", sev: "INFO" },
  { key: "warning", sev: "WARNING" },
  { key: "critical", sev: "HIGH" },
  { key: "breach", sev: "CRITICAL" },
];

async function evaluateOccupancy(res: TickResult): Promise<void> {
  const summaries = await getWarehouseSummaries();
  for (const s of summaries) {
    const t = thresholdsFor(s.code);
    const pct = s.pct;

    // level saat ini menurut ambang naik
    let level = 0;
    for (let i = 0; i < LADDER.length; i++) {
      if (pct >= t[LADDER[i].key]) level = i + 1;
    }
    const stateKey = `occ:${s.code}`;
    const armed = Number((await getState(stateKey)) ?? "0");
    const dedupKey = `OCC:${s.code}`;

    if (level > armed) {
      // menembus ambang baru → alert (buat baru atau upgrade yang terbuka)
      const lad = LADDER[level - 1];
      const horizon =
        s.hours_to_95 !== null ? ` Estimasi ≈ ${Math.round(s.hours_to_95)} jam menuju 95%.` : "";
      const v: Violation = {
        rule_id: `OCC-${lad.key.toUpperCase()}`,
        rule_name: "Occupancy Threshold",
        severity: lad.sev,
        warehouse_code: s.code,
        zone: null, sloc_code: null, sku: null,
        title: `Okupansi ${s.code} mencapai ${pct}% (ambang ${t[lad.key]}%)`,
        detail: `Okupansi gudang ${s.name} (${s.code}) kini ${pct}% — melewati ambang ${lad.key} ${t[lad.key]}%. Terisi ${s.basis === "qty" ? `${Math.round(s.occ_qty)}/${Math.round(s.cap_qty)} unit` : `${s.occ_cbm}/${s.cap_cbm} m³`}; SLOC kosong ${s.sloc_empty}.${horizon} Tindak lanjut sesuai SOP-001/002.`,
        dedup_key: dedupKey,
      };
      const existing = await openAlertByKey(dedupKey);
      let alertRow: Alert;
      if (existing) {
        await bumpAlert(existing, v);
        alertRow = { ...existing, severity: v.severity, title: v.title, detail: v.detail, occurrences: existing.occurrences + 1 };
        res.updated++;
      } else {
        alertRow = await insertAlert(v);
        res.created++;
      }
      res.notified += await dispatchToLevel(alertRow, alertRow.escalation_level);
      await setState(stateKey, String(level));
    } else if (level < armed) {
      // turun: re-arm hanya setelah melewati (ambang level ter-arm − buffer)
      const armedThreshold = t[LADDER[armed - 1].key];
      if (pct < armedThreshold - t.hysteresis_buffer) {
        await setState(stateKey, String(level));
        if (level === 0) {
          const open = await openAlertByKey(dedupKey);
          if (open) {
            await systemResolve(
              open.alert_id,
              `Okupansi ${s.code} turun ke ${pct}% (di bawah ${t.monitor}% − buffer ${t.hysteresis_buffer}).`
            );
            res.auto_resolved++;
          }
        }
      }
      // di dalam zona buffer: diam — inilah anti-flapping.
    }
  }
}

// ---- 2+3) rule evaluation ---------------------------------------------------
async function evaluateRules(res: TickResult): Promise<void> {
  const cfg = getRules();
  const activeStateKeys = new Map<string, Set<string>>(); // rule_id -> dedup keys still violating

  for (const rule of cfg.rules) {
    const evaluator = RULE_EVALUATORS[rule.id];
    if (!evaluator || !rule.enabled) continue;
    res.evaluated_rules.push(rule.id);
    const violations = await evaluator({
      params: rule.params,
      severity: rule.severity,
    });

    if (STATE_RULES.has(rule.id)) {
      activeStateKeys.set(rule.id, new Set(violations.map((v) => v.dedup_key)));
    }

    for (const v of violations) {
      const existing = await openAlertByKey(v.dedup_key);
      if (existing) {
        await bumpAlert(existing, v);
        res.updated++;
      } else {
        const a = await insertAlert(v);
        res.created++;
        res.notified += await dispatchToLevel(a, a.escalation_level);
      }
    }
  }

  // auto-resolve state rules yang sudah pulih
  for (const [ruleId, keys] of activeStateKeys) {
    const open = await stateQuery<Alert>(
      `SELECT * FROM alerts WHERE rule_id = ? AND status IN ${OPEN}`,
      [ruleId]
    );
    for (const a of open) {
      if (!keys.has(a.dedup_key)) {
        await systemResolve(a.alert_id, "Kondisi sudah tidak terdeteksi pada evaluasi terakhir.");
        res.auto_resolved++;
      }
    }
  }

}

// ---- 4) escalation ----------------------------------------------------------
async function evaluateEscalation(res: TickResult): Promise<void> {
  const due = await stateQuery<Alert>(
    `SELECT * FROM alerts
     WHERE status IN ('NEW','NOTIFIED')
       AND next_escalation_at IS NOT NULL AND next_escalation_at <= now()`
  );
  const cfg = getRecipients();
  const maxLevel = Math.max(...cfg.levels.map((l) => l.level));
  for (const a of due) {
    if (a.escalation_level >= maxLevel) {
      await stateExec("UPDATE alerts SET next_escalation_at = NULL WHERE alert_id = ?", [a.alert_id]);
      continue;
    }
    const newLevel = a.escalation_level + 1;
    const delay = nextEscalationDelayMin(newLevel);
    await stateExec(
      `UPDATE alerts SET escalation_level = ?, updated_at = now(),
          status = 'NOTIFIED',
          next_escalation_at = ${delay === null ? "NULL" : `now() + INTERVAL ${delay} MINUTE`}
       WHERE alert_id = ?`,
      [newLevel, a.alert_id]
    );
    const lvName = cfg.levels.find((l) => l.level === newLevel)?.name ?? `L${newLevel}`;
    await stateExec(
      "INSERT INTO alert_events VALUES (?, ?, now(), 'system', 'ESCALATED', ?)",
      [uid("evt-"), a.alert_id, `Naik ke ${lvName} (tanpa acknowledgement)`]
    );
    res.notified += await dispatchToLevel(
      { ...a, escalation_level: newLevel },
      newLevel,
      `ESKALASI ${lvName}`
    );
    res.escalated++;
  }
}

// ---- entry ------------------------------------------------------------------
async function runTickInternal(actor: string): Promise<TickResult> {
  const res: TickResult = {
    created: 0, updated: 0, auto_resolved: 0, escalated: 0, notified: 0, evaluated_rules: [],
  };
  await evaluateOccupancy(res);
  await evaluateRules(res);
  await evaluateEscalation(res);
  await audit(actor, "TICK", "alert_engine", undefined, res);
  return res;
}

// A manual click and a scheduler request can arrive at the same time. Serialise
// them in this web process so the read-then-insert dedup flow cannot emit two
// alerts/notifications for the same breach.
let activeTick: Promise<TickResult> | null = null;

export async function runTick(actor: string): Promise<TickResult> {
  if (activeTick) return activeTick;
  activeTick = runTickInternal(actor).finally(() => { activeTick = null; });
  return activeTick;
}
