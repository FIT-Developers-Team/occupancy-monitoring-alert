// Google Chat incoming webhook — alert real-time saat breach zona tercipta/eskalasi.
// threadKey = dedup_key agar satu kejadian tetap berada dalam satu thread.
import type { Alert } from "@/types";
import {
  isGoogleChatWebhookUrl,
  normalizeGoogleChatMentionIds,
} from "@/lib/notify/gchat-url";

const SEV_ICON: Record<string, string> = {
  INFO: "\u2139\uFE0F",
  WARNING: "\uD83D\uDFE1",
  HIGH: "\uD83D\uDFE0",
  CRITICAL: "\uD83D\uDD34",
  EMERGENCY: "\uD83D\uDEA8",
};
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface GChatSendResult {
  ok: boolean;
  status?: number;
  error?: string;
  retryable?: boolean;
}

function withThread(url: string, threadKey: string): string {
  const target = new URL(url);
  target.searchParams.set("threadKey", threadKey.slice(0, 512));
  target.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
  return target.toString();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function googleChatMentionText(values: string[]): string {
  return normalizeGoogleChatMentionIds(values).map((id) => `<users/${id}>`).join(" ");
}

function addMentions(text: string, mentionUserIds: string[]): string {
  const mentions = googleChatMentionText(mentionUserIds);
  return mentions ? `${mentions}\n${text}` : text;
}

async function post(url: string, body: unknown): Promise<GChatSendResult> {
  if (!isGoogleChatWebhookUrl(url)) {
    return { ok: false, error: "URL incoming webhook Google Chat tidak valid.", retryable: false };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12_000),
      });
      if (response.ok) return { ok: true, status: response.status };

      const responseText = (await response.text().catch(() => ""))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 220);
      const retryable = RETRYABLE_STATUS.has(response.status);
      if (retryable && attempt === 0) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter)
          ? Math.min(2_000, Math.max(250, retryAfter * 1_000))
          : 600;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      return {
        ok: false,
        status: response.status,
        retryable,
        error: `Google Chat HTTP ${response.status}${responseText ? `: ${responseText}` : ""}`,
      };
    } catch (error) {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      return { ok: false, error: (error as Error).message, retryable: true };
    }
  }
  return { ok: false, error: "Google Chat tidak merespons.", retryable: true };
}

/** Kartu breach zona + fallback text yang memuat @mention per warehouse. */
export async function sendGChatAlert(
  webhookUrl: string,
  alert: Alert,
  escalationPrefix?: string,
  mentionUserIds: string[] = [],
): Promise<GChatSendResult> {
  const base = process.env.APP_BASE_URL?.replace(/\/$/, "");
  const location = [
    alert.warehouse_code,
    alert.zone ? `Zona ${alert.zone}` : null,
    alert.sloc_code,
    alert.sku,
  ].filter(Boolean).join(" · ");
  const prefix = escalationPrefix ? ` — ${escalationPrefix}` : "";
  const fallback = addMentions(
    `${SEV_ICON[alert.severity] ?? ""} [${alert.severity}] ${alert.rule_name}${prefix} — ${location}\n${alert.title}`,
    mentionUserIds,
  );
  const card = {
    text: fallback,
    cardsV2: [{
      cardId: alert.alert_id,
      card: {
        header: {
          title: `${SEV_ICON[alert.severity] ?? ""} [${alert.severity}] ${alert.rule_name}${prefix}`,
          subtitle: location,
        },
        sections: [{
          widgets: [
            { textParagraph: { text: `<b>${escapeHtml(alert.title)}</b>` } },
            { textParagraph: { text: escapeHtml(alert.detail) } },
            { textParagraph: { text: `<i>Alert ${escapeHtml(alert.alert_id)} · kejadian ke-${alert.occurrences}</i>` } },
            ...(base ? [{
              buttonList: { buttons: [{
                text: "Buka alert — Tangani / Selesaikan",
                onClick: { openLink: { url: `${base}/alerts?id=${encodeURIComponent(alert.alert_id)}` } },
              }] },
            }] : []),
          ],
        }],
      },
    }],
  };
  return post(withThread(webhookUrl, alert.dedup_key), card);
}

/** Pesan teks polos untuk uji koneksi dan ringkasan. */
export async function sendGChatText(
  webhookUrl: string,
  text: string,
  threadKey?: string,
  mentionUserIds: string[] = [],
): Promise<GChatSendResult> {
  const url = threadKey ? withThread(webhookUrl, threadKey) : webhookUrl;
  return post(url, { text: addMentions(text, mentionUserIds) });
}

/** Webhook generik: POST JSON alert apa adanya (n8n / Apps Script / tiket internal). */
export async function sendGenericWebhook(
  url: string,
  alert: Alert,
  escalationPrefix?: string,
): Promise<GChatSendResult> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        source: "fit-occupancy-alert-and-monitoring",
        escalation: escalationPrefix ?? null,
        alert,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (response.ok) return { ok: true, status: response.status };
    return { ok: false, status: response.status, error: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: (error as Error).message, retryable: true };
  }
}
