// Mesin alert: SATU pemicu, dan pemicunya adalah KEJADIAN, bukan keadaan.
//
// APA YANG BERUBAH DAN KENAPA
// ---------------------------
// Versi sebelumnya memindai seluruh zona dan lokasi padat pada setiap tick,
// lalu memberitakan apa pun yang kebetulan berada di atas ambang. Itu
// memberitakan KEADAAN — dan keadaan tidak berubah di antara tick. Sebuah zona
// yang memang kronis penuh menghasilkan alert yang tidak pernah bisa
// dikosongkan siapa pun, dan papan yang tidak pernah bisa dikosongkan berhenti
// dibaca. Di saat yang sama, satu-satunya hal yang benar-benar layak ditindak —
// seseorang baru saja menaruh barang di lokasi yang tidak muat — tenggelam di
// antara ratusan baris yang sudah ada sejak minggu lalu.
//
// Sekarang hanya ada satu aturan:
//
//   ADA BARANG MASUK KE SEBUAH LOKASI, DAN LOKASI ITU KINI LEWAT KAPASITAS.
//
// Konsekuensinya seluruh alert selalu dapat menjawab tiga pertanyaan sekaligus
// tanpa perlu dijelaskan: apa yang berubah, siapa yang melakukannya, dan berapa
// banyak yang harus dipindahkan. Zona tidak lagi beralert — sebuah zona penuh
// adalah kesimpulan yang dibaca di halaman Okupansi, bukan kejadian yang perlu
// membangunkan orang.
//
// Tingkat keparahan tetap ditentukan lib/alerts/severity.ts: satu basis lewat
// kapasitas masih bisa berarti angka master basis itu yang salah, sedangkan Qty
// DAN CBM sama-sama lewat berarti dua pengukuran independen sepakat lokasinya
// memang penuh.
import { stateExec, stateQuery, uid } from "@/lib/db";
import { getRecipients, getThresholds } from "@/lib/config";
import {
  getMovementBreaches,
  getSlocBasisReadings,
  SLOC_BASIS_READING_MAX,
  type MovementBreach,
} from "@/lib/queries";
import { statusFor } from "@/lib/occupancy";
import { dispatchThroughLevel, dispatchToLevel, type DispatchResult } from "@/lib/notify/dispatch";
import { classifyOverflow, hasExceededCapacity, type OverflowVerdict } from "@/lib/alerts/severity";
import { audit } from "@/lib/audit";
import { buildBreachMessage } from "@/lib/alerts/message";
import type { Alert, Severity } from "@/types";

const OPEN = "('NEW','NOTIFIED','ACKNOWLEDGED')";
/** Satu-satunya aturan yang aktif. */
const SLOC_BREACH_RULE = "OCC-SLOC-BREACH";
/** Jam evaluasi terakhir, supaya jendela pergerakan menutup celah antar tick. */
const LAST_TICK_KEY = "movement-breach:last-tick";

export interface TickResult {
  created: number;
  updated: number;
  auto_resolved: number;
  escalated: number;
  notified: number;
  notification_failed: number;
  notification_skipped: number;
  evaluated_rules: string[];
  /** Jendela pergerakan yang benar-benar diperiksa pada pass ini (jam). */
  window_hours: number;
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
  return getRecipients().severity_start_level[severity] ?? 1;
}

function nextEscalationDelayMin(level: number): number | null {
  return getRecipients().levels.find((item) => item.level === level + 1)?.delay_minutes ?? null;
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
      id, violation.rule_id, violation.rule_name, violation.severity,
      violation.warehouse_code, violation.zone, violation.sloc_code, violation.sku,
      violation.title, violation.detail, violation.dedup_key, level,
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

interface BumpOutcome {
  alert: Alert;
  /** Severity naik pada pass ini, sehingga tingkat baru perlu diberi tahu. */
  upgraded: boolean;
}

/**
 * Perbarui alert yang masih terbuka dengan bacaan terbaru.
 *
 * Isi alert diperbarui setiap kali kondisinya terlihat lagi, tetapi jam
 * eskalasi HANYA disetel ulang ketika severity benar-benar naik. Menulis ulang
 * `next_escalation_at` pada setiap pass — yang dilakukan versi lama — membuat
 * jamnya selalu di-reset sebelum jatuh tempo, sehingga tidak ada alert yang
 * pernah naik level seberapa lama pun tidak di-acknowledge.
 *
 * Alert yang hidup juga tidak pernah diturunkan tingkatnya: pemulihan adalah
 * tugas auto-resolve, bukan penurunan diam-diam.
 */
async function bumpAlert(existing: Alert, violation: Violation): Promise<BumpOutcome> {
  const upgraded =
    SEVERITY_ORDER.indexOf(violation.severity) > SEVERITY_ORDER.indexOf(existing.severity);
  const severity = upgraded ? violation.severity : existing.severity;
  const level = Math.max(existing.escalation_level, startLevelFor(severity));
  const delay = nextEscalationDelayMin(level);
  const levelChanged = level > existing.escalation_level;

  await stateExec(
    `UPDATE alerts SET occurrences = occurrences + 1, updated_at = now(),
        severity = ?, title = ?, detail = ?, escalation_level = ?${
          levelChanged
            ? `, next_escalation_at = ${delay === null ? "NULL" : `now() + INTERVAL ${delay} MINUTE`}`
            : ""
        }
     WHERE alert_id = ?`,
    [severity, violation.title, violation.detail, level, existing.alert_id],
  );
  if (levelChanged) {
    await stateExec(
      "INSERT INTO alert_events VALUES (?, ?, now(), 'system', 'ESCALATED', ?)",
      [uid("evt-"), existing.alert_id, `Naik ke level ${level} (${severity})`],
    );
  } else if (upgraded) {
    await stateExec(
      "INSERT INTO alert_events VALUES (?, ?, now(), 'system', 'SEVERITY_UP', ?)",
      [uid("evt-"), existing.alert_id, `Naik ke ${severity}`],
    );
  }
  return {
    alert: {
      ...existing,
      severity,
      title: violation.title,
      detail: violation.detail,
      escalation_level: level,
      occurrences: existing.occurrences + 1,
    },
    upgraded,
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

/**
 * Satu lokasi yang lewat kapasitas menjadi satu alert.
 *
 * Kalimatnya disusun lib/alerts/message.ts supaya papan alert, kartu Google
 * Chat, dan email tidak mungkin menyebut angka yang berbeda untuk kejadian yang
 * sama.
 */
function breachViolation(row: MovementBreach, verdict: OverflowVerdict): Violation {
  const { title, detail } = buildBreachMessage(row, verdict.exceeded);
  return {
    rule_id: SLOC_BREACH_RULE,
    rule_name: "Lokasi Lewat Kapasitas",
    severity: verdict.severity,
    warehouse_code: row.wh,
    zone: row.zone || null,
    sloc_code: row.sloc_code,
    sku: null,
    title,
    detail,
    dedup_key: `${SLOC_BREACH_RULE}:${row.wh}:${row.sloc_code}`,
  };
}

/**
 * Tutup alert dari aturan yang sudah tidak ada lagi.
 *
 * Instalasi yang berjalan sebelum perubahan ini menyimpan alert breach ZONA dan
 * aturan stok lama yang tidak akan pernah dievaluasi lagi — dan karena tidak
 * pernah dievaluasi, tidak akan pernah tertutup sendiri. Membiarkannya berarti
 * papan alert dibuka dengan daftar yang mustahil dikosongkan pada hari pertama.
 */
async function resolveRetiredRules(result: TickResult): Promise<void> {
  const rows = await stateQuery<{ count: number }>(
    `SELECT count(*)::INT AS count FROM alerts WHERE status IN ${OPEN} AND rule_id <> ?`,
    [SLOC_BREACH_RULE],
  );
  const count = rows[0]?.count ?? 0;
  if (!count) return;
  await stateExec(
    `UPDATE alerts SET status = 'RESOLVED', resolved_by = 'system', resolved_at = now(),
        resolution_note = 'Aturan ini tidak lagi dipakai. Alert kapasitas kini hanya dibuat ketika ada barang masuk yang membuat sebuah lokasi lewat kapasitas.',
        next_escalation_at = NULL, updated_at = now()
     WHERE status IN ${OPEN} AND rule_id <> ?`,
    [SLOC_BREACH_RULE],
  );
  result.auto_resolved += count;
}

/**
 * Jendela pergerakan untuk pass ini.
 *
 * Diukur dari evaluasi terakhir, bukan angka tetap: kalau scheduler sempat
 * berhenti satu jam, pass berikutnya tetap memeriksa seluruh jam itu dan tidak
 * ada barang masuk yang terlewat. Dibatasi 24 jam supaya instalasi yang lama
 * menganggur tidak membangkitkan kembali kejadian kemarin sebagai alert baru.
 */
async function windowHoursForThisPass(fallbackHours: number): Promise<number> {
  const raw = await getState(LAST_TICK_KEY);
  const last = raw ? Number(raw) : NaN;
  if (!Number.isFinite(last) || last <= 0) return fallbackHours;
  const hours = (Date.now() - last) / 3_600_000;
  if (!Number.isFinite(hours) || hours <= 0) return fallbackHours;
  // Sedikit tumpang tindih di sisi bawah: pergerakan yang mendarat tepat saat
  // pass sebelumnya membaca tidak boleh jatuh di antara dua jendela.
  return Math.min(24, Math.max(0.25, hours + 1 / 60));
}

async function evaluateMovementBreaches(result: TickResult): Promise<void> {
  const policy = getThresholds().sloc_alerts;
  if (!policy.enabled) return;
  result.evaluated_rules.push(SLOC_BREACH_RULE);

  const windowHours = await windowHoursForThisPass(policy.window_hours);
  result.window_hours = Math.round(windowHours * 100) / 100;
  const breaches = await getMovementBreaches(windowHours, policy.max_alerts);
  // Ditandai SEBELUM memproses: kalau pass ini gagal di tengah jalan, pass
  // berikutnya tetap maju alih-alih memproses ulang jendela yang sama dan
  // menumpuk `occurrences` pada alert yang sebenarnya hanya terjadi sekali.
  await setState(LAST_TICK_KEY, String(Date.now()));

  for (const row of breaches) {
    const verdict = classifyOverflow(row);
    // Pertahanan berlapis: kuerinya sudah menyaring ke status Breach, tetapi
    // alert hanya boleh dibuat bila ada basis yang benar-benar MELEWATI
    // kapasitas — bukan sekadar menyentuhnya. Kontraknya diuji di
    // tests/alert-severity.test.mjs.
    if (!hasExceededCapacity(verdict)) continue;
    const violation = breachViolation(row, verdict);
    const existing = await openAlertByKey(violation.dedup_key);
    if (existing) {
      const outcome = await bumpAlert(existing, violation);
      result.updated++;
      // Kartu baru hanya saat memburuk. Barang bisa masuk berkali-kali ke
      // lokasi yang sama; memberitakan setiap kalinya membuat Space tidak
      // terbaca dan alert diabaikan.
      if (outcome.upgraded) {
        mergeDispatch(result, await dispatchToLevel(
          outcome.alert, outcome.alert.escalation_level, `NAIK ${outcome.alert.severity}`,
        ));
      }
      continue;
    }
    const alert = await insertAlert(violation);
    result.created++;
    mergeDispatch(result, await dispatchThroughLevel(alert, alert.escalation_level));
  }
}

/**
 * Tutup alert yang lokasinya sudah tidak lewat kapasitas lagi.
 *
 * Diperiksa langsung ke sumber, bukan disimpulkan dari "tidak muncul di daftar
 * pass ini" — daftar pass ini hanya berisi lokasi yang KEBETULAN menerima
 * barang di jendela terakhir, jadi ketiadaan di sana tidak membuktikan apa pun.
 */
async function resolveRecovered(result: TickResult): Promise<void> {
  const open = await stateQuery<Alert>(
    `SELECT * FROM alerts WHERE rule_id = ? AND status IN ${OPEN} AND sloc_code IS NOT NULL
     ORDER BY updated_at DESC LIMIT ${SLOC_BASIS_READING_MAX}`,
    [SLOC_BREACH_RULE],
  );
  if (!open.length) return;

  const readings = await getSlocBasisReadings(
    open.map((alert) => ({ wh: alert.warehouse_code, sloc: alert.sloc_code as string })),
  );
  for (const alert of open) {
    const reading = readings.get(`${alert.warehouse_code}|${alert.sloc_code}`);
    if (!reading) {
      // Lokasinya hilang dari master atau zonanya dinonaktifkan: kondisinya
      // tidak dapat diamati lagi, dan alert yang tidak dapat diamati tidak akan
      // pernah bisa ditutup siapa pun.
      await systemResolve(
        alert.alert_id,
        `Lokasi ${alert.sloc_code} tidak lagi ada pada cakupan okupansi.`,
      );
      result.auto_resolved++;
      continue;
    }
    // Tangga yang sama dengan layar: selama salah satu basis masih Breach,
    // alertnya tetap terbuka.
    const stillBreaching = (["pct_qty", "pct_cbm"] as const).some((key) => {
      const pct = reading[key];
      return pct !== null && statusFor(pct, alert.warehouse_code) === "BREACH";
    });
    if (stillBreaching) continue;
    const worst = Math.max(reading.pct_qty ?? 0, reading.pct_cbm ?? 0);
    await systemResolve(
      alert.alert_id,
      `Lokasi ${alert.sloc_code} kembali di dalam kapasitas (${Math.round(worst * 10) / 10}%).`,
    );
    result.auto_resolved++;
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
      [uid("evt-"), alert.alert_id, `Naik ke ${levelName} — belum ditangani`],
    );
    mergeDispatch(result, await dispatchToLevel(
      { ...alert, escalation_level: newLevel, status: "NOTIFIED" }, newLevel, `ESKALASI ${levelName}`,
    ));
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
    window_hours: 0,
  };
  await resolveRetiredRules(result);
  await evaluateMovementBreaches(result);
  await resolveRecovered(result);
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
