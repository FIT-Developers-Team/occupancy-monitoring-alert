// Routing notifikasi per level eskalasi (config/recipients.json) + logging.
// Channel: Google Chat webhook (real-time) · Email · Webhook generik.
import { getRecipients } from "@/lib/config";
import { stateExec, uid } from "@/lib/db";
import { sendGChatAlert, sendGenericWebhook } from "@/lib/notify/gchat";
import { sendEmail } from "@/lib/notify/email";
import type { Alert } from "@/types";

const sevIcon: Record<string, string> = {
  INFO: "ℹ️", WARNING: "🟡", HIGH: "🟠", CRITICAL: "🔴", EMERGENCY: "🚨",
};

export function alertText(a: Alert, escalationPrefix?: string): string {
  const lines = [
    `${sevIcon[a.severity] ?? ""} [${a.severity}] ${a.rule_name}${escalationPrefix ? ` — ${escalationPrefix}` : ""}`,
    `Gudang: ${a.warehouse_code}${a.zone ? ` · Zona ${a.zone}` : ""}${a.sloc_code ? ` · ${a.sloc_code}` : ""}${a.sku ? ` · ${a.sku}` : ""}`,
    a.title,
    "",
    a.detail,
    "",
    `Alert ${a.alert_id} · kejadian ke-${a.occurrences}`,
  ];
  return lines.join("\n");
}

const short = (s: string) => (s.length > 46 ? `…${s.slice(-42)}` : s);

async function log(
  alertId: string, channel: string, recipient: string, status: string, message: string
) {
  await stateExec(
    "INSERT INTO notification_log VALUES (?, ?, ?, ?, now(), ?, ?)",
    [uid("ntf-"), alertId, channel, recipient, status, message.slice(0, 400)]
  );
}

/** Kirim alert ke semua penerima pada satu level eskalasi. */
export async function dispatchToLevel(
  a: Alert,
  level: number,
  escalationPrefix?: string
): Promise<number> {
  const cfg = getRecipients();
  const lv = cfg.levels.find((l) => l.level === level);
  if (!lv) return 0;
  let sent = 0;

  for (const hook of lv.gchat_webhooks) {
    const r = await sendGChatAlert(hook, a, escalationPrefix);
    await log(a.alert_id, "gchat", short(hook), r.ok ? "SENT" : "SKIPPED", r.ok ? "ok" : r.error || "");
    if (r.ok) sent++;
  }
  for (const em of lv.emails) {
    const r = await sendEmail(em, `[${a.severity}] ${a.rule_name} — ${a.warehouse_code}`, alertText(a, escalationPrefix));
    await log(a.alert_id, "email", em, r.ok ? "SENT" : "SKIPPED", r.ok ? "ok" : r.error || "");
    if (r.ok) sent++;
  }
  for (const url of lv.webhooks) {
    const r = await sendGenericWebhook(url, a, escalationPrefix);
    await log(a.alert_id, "webhook", short(url), r.ok ? "SENT" : "SKIPPED", r.ok ? "ok" : r.error || "");
    if (r.ok) sent++;
  }
  // Selalu tercatat di Notification Center dashboard meski channel eksternal kosong.
  if (lv.gchat_webhooks.length + lv.emails.length + lv.webhooks.length === 0) {
    await log(a.alert_id, "dashboard", lv.name, "SENT", "in-app only");
    sent++;
  }
  return sent;
}
