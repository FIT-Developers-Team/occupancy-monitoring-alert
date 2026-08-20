// Alert engine fase saat ini:
//   1. Okupansi zona dan lokasi dinilai pada KEDUA basis kapasitas, bukan hanya
//      basis kebijakan, dan dibedakan antara TEPAT di kapasitas maksimum dengan
//      MELEBIHI kapasitas:
//        satu basis tepat di kapasitas          -> High
//        satu basis melebihi kapasitas          -> Critical
//        Qty dan CBM tepat di kapasitas         -> Critical
//        satu basis lewat + satu basis tepat     -> Breach
//        Qty dan CBM melebihi kapasitas         -> Breach
//      Lihat lib/alerts/severity.ts. Kondisi dua basis tepat di max dikunci
//      Critical; tingkat kondisi lain tetap dapat diatur admin.
//   2. Hysteresis mencegah alert berulang saat nilai berosilasi dekat ambang.
//   3. Alert pulih otomatis setelah zona turun di bawah breach - buffer.
//   4. Alert tanpa acknowledgement naik mengikuti level dinamis. Jam eskalasi
//      hanya di-reset saat severity benar-benar naik, bukan setiap kali kondisi
//      yang sama terlihat lagi.
// Rule berbasis movement/stok sengaja tidak dijalankan sampai datanya tersedia.
import { stateExec, stateQuery, uid } from "@/lib/db";
import { getRecipients, getThresholds, thresholdsFor } from "@/lib/config";
import {
  getDenseSlocs,
  getSlocBasisReadings,
  getZoneSummary,
  SLOC_BASIS_READING_MAX,
  type DenseSloc,
} from "@/lib/queries";
import { dispatchThroughLevel, dispatchToLevel, type DispatchResult } from "@/lib/notify/dispatch";
import {
  basisNames,
  CAPACITY_LIMIT_PCT,
  CAPACITY_MATCH_TOLERANCE_PCT,
  classifyOverflow,
  isAtCapacityOnly,
  isDualBasis,
  isZoneCapacityRecovered,
  overflowReason,
  shouldKeepSlocCapacityAlertOpen,
  shouldTriggerSlocCapacityAlert,
  shouldTriggerZoneCapacityAlert,
  type OverflowVerdict,
} from "@/lib/alerts/severity";
import { audit } from "@/lib/audit";
import type { Alert, Severity, ZoneSummary } from "@/types";

const OPEN = "('NEW','NOTIFIED','ACKNOWLEDGED')";
const ZONE_BREACH_RULE = "OCC-ZONE-BREACH";
const SLOC_BREACH_RULE = "OCC-SLOC-BREACH";

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

interface BumpOutcome {
  alert: Alert;
  /** Severity naik pada pass ini, sehingga tingkat baru perlu diberi tahu. */
  upgraded: boolean;
}

/**
 * Perbarui alert yang masih terbuka dengan bacaan terbaru.
 *
 * Dua hal dijaga terpisah di sini, dan mencampurnya adalah bug yang diperbaiki
 * versi ini:
 *
 *  - Isi alert (judul, detail, jumlah kemunculan) diperbarui setiap kali
 *    kondisinya terlihat lagi.
 *  - Jam eskalasi HANYA disetel ulang ketika severity benar-benar naik.
 *
 * Sebelumnya `next_escalation_at` ikut ditulis pada setiap pemanggilan. Karena
 * lokasi yang kelebihan kapasitas terlihat lagi pada setiap tick sepuluh menit,
 * jamnya selalu di-reset sebelum jatuh tempo — dan alert lokasi tidak pernah
 * naik level sama sekali, seberapa lama pun tidak di-acknowledge.
 *
 * Alert yang hidup juga tidak pernah diturunkan tingkatnya: yang sudah sampai
 * ke level 3 tidak boleh diam-diam kembali ke level 1 karena satu bacaan
 * membaik sedikit. Pemulihan adalah tugas auto-resolve, bukan penurunan diam.
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
      [uid("evt-"), existing.alert_id, `Severity naik ke ${severity} — langsung ke level ${level}`],
    );
  } else if (upgraded) {
    await stateExec(
      "INSERT INTO alert_events VALUES (?, ?, now(), 'system', 'SEVERITY_UP', ?)",
      [uid("evt-"), existing.alert_id, `Severity naik ke ${severity}`],
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

const id = (value: number) => value.toLocaleString("id-ID");

/** "Qty 118% (1.200/1.016 unit) · CBM 96% (2,4/2,5 m³)" — keduanya selalu ada. */
function basisBreakdown(row: {
  pct_qty: number | null; pct_cbm: number | null;
  occ_qty: number; cap_qty: number; occ_cbm: number; cap_cbm: number;
}): string {
  const parts: string[] = [];
  parts.push(row.pct_qty === null
    ? "Qty tidak terukur (kapasitas belum diatur)"
    : `Qty ${id(Math.round(row.pct_qty * 10) / 10)}% (${id(Math.round(row.occ_qty))}/${id(Math.round(row.cap_qty))} unit)`);
  parts.push(row.pct_cbm === null
    ? "CBM tidak terukur (kapasitas belum diatur)"
    : `CBM ${id(Math.round(row.pct_cbm * 10) / 10)}% (${id(row.occ_cbm)}/${id(row.cap_cbm)} m³ efektif)`);
  return parts.join(" · ");
}

function zoneViolation(zone: ZoneSummary, verdict: OverflowVerdict): Violation {
  const threshold = thresholdsFor(zone.wh).breach;
  const dual = isDualBasis(verdict);
  const mixed = verdict.kind === "dual_mixed";
  // "Tepat di kapasitas" hanya berlaku bila TIDAK ADA basis yang melebihinya;
  // begitu satu basis lewat, judulnya harus berkata lewat.
  const exact = isAtCapacityOnly(verdict);
  const headline =
    dual && exact ? `Zona ${zone.zone} di ${zone.wh} tepat di kapasitas maksimum pada Qty dan CBM`
    : mixed ? `Zona ${zone.zone} di ${zone.wh}: ${basisNames(verdict.exceeded)} melewati kapasitas, ${basisNames(verdict.at_capacity)} tepat di batas`
    : dual ? `Zona ${zone.zone} di ${zone.wh} melewati kapasitas pada Qty dan CBM`
    : verdict.reached.length
      ? `Zona ${zone.zone} di ${zone.wh} ${exact ? "tepat di kapasitas maksimum" : "melewati kapasitas"} ${basisNames(verdict.reached)}`
      : `Zona ${zone.zone} di ${zone.wh} mencapai ${zone.pct}%`;
  const action =
    dual && exact
      ? "Hentikan inbound ke zona ini dan prioritaskan outbound: Qty dan CBM sama-sama persis di angka kapasitas maksimum, jadi barang berikutnya yang masuk sudah tidak punya tempat."
      : mixed
        ? "Hentikan inbound dan prioritaskan outbound: Qty dan CBM sama-sama sudah mencapai batas, dan salah satunya sudah melebihi kapasitas."
      : dual
        ? "Hentikan inbound ke zona ini dan prioritaskan outbound: dua pengukuran independen sepakat zona sudah penuh."
        : "Tahan atau alihkan inbound zona ini, prioritaskan outbound, dan pastikan kapasitas master basis yang mencapai batas memang benar.";
  return {
    rule_id: ZONE_BREACH_RULE,
    rule_name: "Kondisi Kapasitas Zona",
    severity: verdict.severity,
    warehouse_code: zone.wh,
    zone: zone.zone,
    sloc_code: null,
    sku: null,
    title: headline,
    detail: `${overflowReason(verdict)} ${basisBreakdown(zone)}. Basis kebijakan ${zone.basis.toUpperCase()} berada di ${zone.pct}% (ambang breach ${threshold}%); ${id(zone.sloc_occupied)} lokasi terisi dan ${id(zone.sloc_empty)} lokasi kosong. ${action}`,
    dedup_key: `${ZONE_BREACH_RULE}:${zone.wh}:${zone.zone}`,
  };
}

async function resolveTriggersDisabledForCurrentPhase(result: TickResult): Promise<void> {
  const rows = await stateQuery<{ count: number }>(
    `SELECT count(*)::INT AS count FROM alerts WHERE status IN ${OPEN} AND rule_id NOT IN (?, ?)`,
    [ZONE_BREACH_RULE, SLOC_BREACH_RULE],
  );
  const count = rows[0]?.count ?? 0;
  if (!count) return;
  // One bulk write avoids tens of thousands of DuckDB round-trips when an
  // existing installation switches from legacy stock rules to zone-only mode.
  await stateExec(
    `UPDATE alerts SET status = 'RESOLVED', resolved_by = 'system', resolved_at = now(),
        resolution_note = 'Trigger dinonaktifkan pada fase saat ini; hanya alert kapasitas zona dan lokasi yang aktif.',
        next_escalation_at = NULL, updated_at = now()
     WHERE status IN ${OPEN} AND rule_id NOT IN (?, ?)`,
    [ZONE_BREACH_RULE, SLOC_BREACH_RULE],
  );
  result.auto_resolved += count;
}

/**
 * Apakah zona ini masih pulih menurut hysteresis.
 *
 * Pemulihan harus memakai ukuran yang sama dengan pemicunya. Karena pemicu kini
 * juga melihat basis non-kebijakan, sebuah zona tidak boleh dinyatakan pulih
 * selama masih ada basis mana pun yang mencapai kapasitas — kalau tidak, zona
 * yang 300% penuh menurut CBM akan ditutup otomatis begitu basis kebijakan
 * Qty-nya turun di bawah ambang.
 */
async function evaluateZoneBreaches(result: TickResult): Promise<void> {
  const zones = await getZoneSummary();
  result.evaluated_rules.push(ZONE_BREACH_RULE);

  for (const zone of zones) {
    const threshold = thresholdsFor(zone.wh);
    const stateKey = `occ-zone-breach:${zone.wh}:${zone.zone}`;
    const armed = (await getState(stateKey)) === "1";
    const verdict = classifyOverflow(zone);
    // Mencapai kapasitas pada basis APA PUN sudah cukup untuk beralert; ambang
    // breach tetap dihormati supaya gudang yang menyetel breach di bawah 100%
    // tidak kehilangan peringatan dininya.
    const breaching = shouldTriggerZoneCapacityAlert(verdict, zone.pct, threshold.breach);
    const dedupKey = `${ZONE_BREACH_RULE}:${zone.wh}:${zone.zone}`;

    if (breaching && !armed) {
      const violation = zoneViolation(zone, verdict);
      const existing = await openAlertByKey(dedupKey);
      const alert = existing
        ? (await bumpAlert(existing, violation)).alert
        : await insertAlert(violation);
      if (existing) result.updated++; else result.created++;
      // Creation engages every tier up to the severity start level; escalation
      // later notifies only the newly engaged tier.
      mergeDispatch(result, await dispatchThroughLevel(alert, alert.escalation_level));
      await setState(stateKey, "1");
      continue;
    }

    // Sebelumnya cabang ini tidak ada: begitu zona ter-arm, kondisinya tidak
    // pernah dinilai lagi sampai pulih. Zona yang memburuk dari "Qty lewat" ke
    // "Qty dan CBM lewat" tetap tampil sebagai Critical selamanya.
    if (breaching && armed) {
      const existing = await openAlertByKey(dedupKey);
      if (!existing) {
        // Alert-nya sudah ditutup manual sementara zonanya masih breach.
        // Melepas arm membuat pass berikutnya membukanya kembali secara wajar.
        await setState(stateKey, "0");
        continue;
      }
      const violation = zoneViolation(zone, verdict);
      const outcome = await bumpAlert(existing, violation);
      result.updated++;
      // Notifikasi hanya saat memburuk. Tanpa syarat ini, satu zona yang penuh
      // akan mengirim kartu Google Chat setiap sepuluh menit tanpa henti.
      if (outcome.upgraded) {
        mergeDispatch(
          result,
          await dispatchToLevel(outcome.alert, outcome.alert.escalation_level, `SEVERITY NAIK ${outcome.alert.severity}`),
        );
      }
      continue;
    }

    if (armed && isZoneCapacityRecovered(
      verdict,
      zone.pct,
      threshold.breach,
      threshold.hysteresis_buffer,
    )) {
      await setState(stateKey, "0");
      const open = await openAlertByKey(dedupKey);
      if (open) {
        await systemResolve(
          open.alert_id,
          `Okupansi zona ${zone.wh}/${zone.zone} turun ke ${zone.pct}% dan tidak ada basis yang mencapai kapasitas (di bawah ${threshold.breach}% - buffer ${threshold.hysteresis_buffer}%).`,
        );
        result.auto_resolved++;
      }
    }
  }
}

function slocViolation(sloc: DenseSloc, minPct: number, verdict: OverflowVerdict): Violation {
  const scope = `zona ${sloc.zone || "—"}, ${sloc.storage || "penyimpanan umum"}`;
  const dual = isDualBasis(verdict);
  const mixed = verdict.kind === "dual_mixed";
  const exact = isAtCapacityOnly(verdict);
  const headline =
    dual && exact ? `${sloc.sloc_code} tepat di kapasitas maksimum Qty dan CBM`
    : mixed ? `${sloc.sloc_code}: ${basisNames(verdict.exceeded)} melebihi kapasitas, ${basisNames(verdict.at_capacity)} tepat di batas`
    : dual ? `${sloc.sloc_code} melebihi kapasitas Qty dan CBM`
    : verdict.reached.length
      ? `${sloc.sloc_code} ${exact ? "tepat di kapasitas maksimum" : "melebihi kapasitas"} ${basisNames(verdict.reached)} (${id(sloc.ranking_pct)}%)`
      : `${sloc.sloc_code} terisi ${id(sloc.ranking_pct)}% dari kapasitas`;
  const action =
    dual && exact
      ? "Berhenti menempatkan barang di lokasi ini: unit maupun volume sama-sama persis di angka kapasitas maksimum, jadi tambahan berikutnya pasti tidak muat."
      : mixed
        ? "Hentikan penempatan tambahan dan pindahkan kelebihan ke lokasi kosong terdekat: kedua basis sudah penuh dan salah satunya sudah melampaui kapasitas."
      : dual
        ? "Pindahkan kelebihan ke lokasi kosong terdekat: unit maupun volume sama-sama sudah melampaui kapasitas, jadi ini bukan sekadar angka master yang salah."
        : "Periksa penempatan, pindahkan kelebihan ke lokasi kosong terdekat, atau perbarui kapasitas master pada basis yang mencapai batas bila angkanya memang salah.";
  // Kalimat pemicu harus menyebut alasan yang sebenarnya. Lokasi yang Qty dan
  // CBM-nya sama-sama mencapai kapasitas masuk daftar TANPA melewati ambang
  // lokasi padat, jadi menyebut ambang itu di sini akan menjadi keterangan
  // yang salah pada justru alert yang paling penting.
  const trigger = dual
    ? "Qty dan CBM sama-sama mencapai kapasitas"
    : `melewati ambang lokasi padat ${minPct}%`;
  return {
    rule_id: SLOC_BREACH_RULE,
    rule_name: "Kondisi Kapasitas Lokasi",
    // Tingkat keparahan mengikuti berapa banyak basis yang mencapai kapasitas
    // dan apakah kapasitasnya benar-benar terlampaui, bukan satu nilai tetap.
    // Satu lokasi yang hanya lewat pada satu basis memang pekerjaan
    // housekeeping; yang lewat pada keduanya bukan.
    severity: verdict.severity,
    warehouse_code: sloc.wh,
    zone: sloc.zone || null,
    sloc_code: sloc.sloc_code,
    sku: null,
    title: headline,
    detail: `Lokasi ${sloc.sloc_code} (${scope}) masuk daftar alert karena ${trigger}. ${overflowReason(verdict)} ${basisBreakdown(sloc)}. Berisi ${id(sloc.sku_count)} SKU. ${action}`,
    dedup_key: `${SLOC_BREACH_RULE}:${sloc.wh}:${sloc.sloc_code}`,
  };
}

/**
 * Apakah lokasi ini layak beralert.
 *
 * `sloc_alerts.min_pct` (bawaan 110%) adalah pengendali VOLUME notifikasi:
 * ratusan lokasi duduk sedikit di atas kapasitas Qty-nya setiap saat, dan
 * memberitakan semuanya membuat Space tidak terbaca. Ambang itu tetap berlaku
 * untuk kondisi satu basis.
 *
 * Kondisi dua basis dikecualikan dengan sengaja. Ketika Qty DAN CBM sama-sama
 * mencapai kapasitas, dua pengukuran independen sepakat lokasinya memang penuh
 * — tidak ada penjelasan "angka masternya salah" yang tersisa. Menahan alert
 * itu sampai 110% berarti menuntut lokasinya kelebihan sepersepuluh dulu
 * sebelum siapa pun diberi tahu, padahal 100% pada keduanya justru kondisi
 * yang paling layak ditindak.
 */
async function evaluateSlocBreaches(result: TickResult): Promise<void> {
  const thresholds = getThresholds();
  const policy = thresholds.sloc_alerts;
  if (!policy.enabled) return;
  result.evaluated_rules.push(SLOC_BREACH_RULE);

  // Lantai pemindaian, BUKAN ambang alert.
  //
  // Daftar kandidat harus turun sampai batas kapasitas itu sendiri, kalau tidak
  // lokasi yang Qty dan CBM-nya sama-sama tepat 100% tidak pernah terlihat oleh
  // mesin ini sama sekali — dan aturan "dua basis di kapasitas maksimum =
  // Critical" tidak akan pernah dapat berbunyi. Yang benar-benar diberitakan
  // tetap disaring shouldTriggerSlocCapacityAlert() di bawah.
  //
  // Toleransi ikut dikurangkan karena penyaringan di SQL memakai persentase
  // mentah sementara penilaian memakai angka yang sudah dibulatkan satu desimal
  // seperti yang tampil di layar: tanpa ini, lokasi 99,97% yang terbaca "100,0%"
  // tersaring keluar justru sebelum sempat dinilai.
  const capacityFloor = CAPACITY_LIMIT_PCT - CAPACITY_MATCH_TOLERANCE_PCT;
  const scanFloor = Math.min(policy.min_pct, capacityFloor);
  // Diperingkat pada basis TERPARAH di antara Qty dan CBM, bukan basis
  // kebijakan. Dengan pemeringkatan lama, lokasi yang 5.000% penuh menurut CBM
  // tidak pernah masuk daftar bila basis kebijakannya Qty dan Qty-nya longgar —
  // justru kasus yang paling perlu dilihat orang.
  const slocs = await getDenseSlocs(undefined, scanFloor, policy.max_alerts, "worst");
  const stillBreaching = new Set<string>();

  for (const sloc of slocs) {
    const verdict = classifyOverflow(sloc);
    if (!shouldTriggerSlocCapacityAlert(verdict, policy.min_pct)) continue;
    const violation = slocViolation(sloc, policy.min_pct, verdict);
    stillBreaching.add(violation.dedup_key);
    const existing = await openAlertByKey(violation.dedup_key);
    if (existing) {
      const outcome = await bumpAlert(existing, violation);
      result.updated++;
      // Kartu notifikasi baru hanya dikirim saat kondisinya memburuk. Lokasi
      // yang sama akan terlihat lagi pada setiap tick; memberitakannya berulang
      // membuat Space tidak terbaca dan alert diabaikan.
      if (outcome.upgraded) {
        mergeDispatch(
          result,
          await dispatchToLevel(outcome.alert, outcome.alert.escalation_level, `SEVERITY NAIK ${outcome.alert.severity}`),
        );
      }
      continue;
    }
    const alert = await insertAlert(violation);
    result.created++;
    mergeDispatch(result, await dispatchThroughLevel(alert, alert.escalation_level));
  }

  // Daftar di atas dibatasi `max_alerts`, jadi "tidak muncul di daftar" tidak
  // membuktikan apa-apa: bisa jadi lokasinya hanya kalah peringkat. Versi lama
  // menyelesaikan itu dengan melewati penutupan otomatis setiap kali daftar
  // penuh — dan di gudang yang memang kronis penuh daftar itu SELALU penuh,
  // sehingga tidak ada satu pun alert lokasi yang pernah tertutup sendiri.
  // Sisanya diperiksa langsung ke sumber, satu kueri untuk semuanya.
  const open = await stateQuery<Alert>(
    `SELECT * FROM alerts WHERE rule_id = ? AND status IN ${OPEN}`,
    [SLOC_BREACH_RULE],
  );
  // Dipotong pada batas yang sama dengan kuerinya. Tanpa ini, alert ke-501 dan
  // seterusnya tidak akan pernah mendapat bacaan — dan cabang "tidak ada
  // bacaan" di bawah akan menutupnya sebagai lokasi yang hilang, padahal ia
  // hanya tidak pernah ditanyakan. Sisanya diperiksa pada pass berikutnya.
  const unverified = open
    .filter((alert) => !stillBreaching.has(alert.dedup_key) && alert.sloc_code)
    .slice(0, SLOC_BASIS_READING_MAX);
  if (!unverified.length) return;

  const readings = await getSlocBasisReadings(
    unverified.map((alert) => ({ wh: alert.warehouse_code, sloc: alert.sloc_code as string })),
  );
  for (const alert of unverified) {
    const reading = readings.get(`${alert.warehouse_code}|${alert.sloc_code}`);
    if (!reading) {
      // Lokasinya hilang dari data master atau zonanya dinonaktifkan. Kondisi
      // yang memicu alert tidak dapat diamati lagi, jadi menahannya terbuka
      // hanya menyisakan alert yang tidak pernah bisa ditutup siapa pun.
      await systemResolve(
        alert.alert_id,
        `Lokasi ${alert.sloc_code} tidak lagi ada pada cakupan okupansi (data master berubah atau zonanya dinonaktifkan).`,
      );
      result.auto_resolved++;
      continue;
    }
    const verdict = classifyOverflow(reading);
    const worst = verdict.worstPct ?? 0;
    // Alert tetap terbuka selama ada basis mana
    // pun yang masih mencapai kapasitas, atau selama masih di atas ambang
    // lokasi padat. Menutupnya lebih awal dari itu membuat alert yang sama
    // terbuka dan tertutup bergantian setiap tick.
    if (shouldKeepSlocCapacityAlertOpen(verdict, policy.min_pct)) continue;
    await systemResolve(
      alert.alert_id,
      `Lokasi ${alert.sloc_code} turun ke ${Math.round(worst * 10) / 10}% dan tidak ada basis yang mencapai kapasitas (ambang ${policy.min_pct}%).`,
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
  await evaluateSlocBreaches(result);
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
