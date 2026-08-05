// Routing notifikasi per level eskalasi + per-warehouse Google Chat routes.
import { getRecipients } from "@/lib/config";
import { stateExec, uid } from "@/lib/db";
import { sendGChatAlert, sendGenericWebhook, type ThreadTarget } from "@/lib/notify/gchat";
import { normalizeGoogleChatMentionIds, redactGoogleChatWebhook } from "@/lib/notify/gchat-url";
import { sendEmail } from "@/lib/notify/email";
import type { Alert } from "@/types";

const severityIcon: Record<string, string> = {
  INFO: "\u2139\uFE0F",
  WARNING: "\uD83D\uDFE1",
  HIGH: "\uD83D\uDFE0",
  CRITICAL: "\uD83D\uDD34",
  EMERGENCY: "\uD83D\uDEA8",
};

export function alertText(alert: Alert, escalationPrefix?: string): string {
  return [
    `${severityIcon[alert.severity] ?? ""} [${alert.severity}] ${alert.rule_name}${escalationPrefix ? ` — ${escalationPrefix}` : ""}`,
    `Gudang: ${alert.warehouse_code}${alert.zone ? ` · Zona ${alert.zone}` : ""}${alert.sloc_code ? ` · ${alert.sloc_code}` : ""}${alert.sku ? ` · ${alert.sku}` : ""}`,
    alert.title,
    "",
    alert.detail,
    "",
    `Alert ${alert.alert_id} · kejadian ke-${alert.occurrences}`,
  ].join("\n");
}

function safeUrlRecipient(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`.slice(0, 180);
  } catch {
    return "webhook";
  }
}

async function log(
  alertId: string,
  channel: string,
  recipient: string,
  status: string,
  message: string,
): Promise<void> {
  await stateExec(
    "INSERT INTO notification_log VALUES (?, ?, ?, ?, now(), ?, ?)",
    [uid("ntf-"), alertId, channel, recipient, status, message.slice(0, 400)],
  );
}

export interface DispatchResult {
  sent: number;
  failed: number;
  skipped: number;
}

/** Kirim alert ke semua penerima yang cocok pada satu level eskalasi. */
export async function dispatchToLevel(
  alert: Alert,
  level: number,
  escalationPrefix?: string,
): Promise<DispatchResult> {
  const config = getRecipients();
  const tier = config.levels.find((item) => item.level === level);
  if (!tier) return { sent: 0, failed: 0, skipped: 1 };

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  // Merge overlapping matches by URL, so one Space receives one post per
  // alert/level even when an admin created overlapping warehouse scopes.
  const googleChatTargets = new Map<string, { label: string; mentions: string[]; thread: ThreadTarget }>();
  for (const route of tier.gchat_routes) {
    if (!route.enabled) continue;
    if (!route.warehouse_codes.includes("*") && !route.warehouse_codes.includes(alert.warehouse_code)) continue;
    const existing = googleChatTargets.get(route.webhook_url);
    googleChatTargets.set(route.webhook_url, {
      label: existing ? `${existing.label}, ${route.label}` : route.label,
      mentions: normalizeGoogleChatMentionIds([
        ...(existing?.mentions ?? []),
        ...route.mention_targets,
      ]),
      // First route wins the thread: two routes sharing one webhook already
      // merge into a single post, so they cannot target two threads.
      // Per-warehouse thread wins over the route-wide one, so a single Space
      // can hold one thread per site.
      thread: existing?.thread ?? {
        mode: route.thread_mode,
        key: route.thread_key,
        name: route.thread_names[alert.warehouse_code]?.trim() || route.thread_name,
      },
    });
  }

  // Backward compatibility: previous global webhook arrays remain deliverable
  // until an admin saves them as explicit routes in the new editor.
  for (const webhookUrl of tier.gchat_webhooks) {
    if (!googleChatTargets.has(webhookUrl)) {
      googleChatTargets.set(webhookUrl, { label: "Rute lama (semua WH)", mentions: [], thread: { mode: "per_alert" } });
    }
  }

  for (const [webhookUrl, target] of googleChatTargets) {
    const result = await sendGChatAlert(webhookUrl, alert, escalationPrefix, target.mentions, target.thread);
    await log(
      alert.alert_id,
      "gchat",
      `${target.label} · ${redactGoogleChatWebhook(webhookUrl)}`.slice(0, 220),
      result.ok ? "SENT" : "FAILED",
      result.ok ? "ok" : result.error || "Google Chat gagal mengirim",
    );
    if (result.ok) sent++; else failed++;
  }

  for (const email of tier.emails) {
    const result = await sendEmail(
      email,
      `[${alert.severity}] ${alert.rule_name} — ${alert.warehouse_code}`,
      alertText(alert, escalationPrefix),
    );
    await log(alert.alert_id, "email", email, result.ok ? "SENT" : "FAILED", result.ok ? "ok" : result.error || "");
    if (result.ok) sent++; else failed++;
  }

  for (const url of tier.webhooks) {
    const result = await sendGenericWebhook(url, alert, escalationPrefix);
    await log(alert.alert_id, "webhook", safeUrlRecipient(url), result.ok ? "SENT" : "FAILED", result.ok ? "ok" : result.error || "");
    if (result.ok) sent++; else failed++;
  }

  if (googleChatTargets.size + tier.emails.length + tier.webhooks.length === 0) {
    const routeExistsForAnotherWarehouse = tier.gchat_routes.some((route) => route.enabled);
    const reason = routeExistsForAnotherWarehouse
      ? `Tidak ada rute Google Chat L${level} untuk ${alert.warehouse_code}; alert hanya tersedia di aplikasi.`
      : "Belum ada penerima eksternal; alert hanya tersedia di aplikasi.";
    await log(alert.alert_id, "dashboard", tier.name, "SENT", reason);
    skipped++;
  }

  if (sent > 0 && alert.status === "NEW") {
    await stateExec(
      "UPDATE alerts SET status = 'NOTIFIED', updated_at = now() WHERE alert_id = ? AND status = 'NEW'",
      [alert.alert_id],
    );
  }

  return { sent, failed, skipped };
}
