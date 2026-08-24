// Google Chat incoming webhook — kartu alert saat sebuah lokasi lewat kapasitas.
// threadKey = dedup_key agar satu kejadian tetap berada dalam satu thread.
import type { Alert } from "@/types";
import {
  isGoogleChatWebhookUrl,
  mentionEmailsOf,
  mentionPingIdOf,
  normalizeGoogleChatMentionIds,
  normalizeGoogleChatThreadName,
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

/**
 * Where a route posts inside the Space.
 *
 * - `per_alert`  one thread per alert, keyed by dedup_key, so repeats and
 *                escalations of the same breach stay together (default).
 * - `single`     every alert joins one fixed thread key — a single running
 *                feed for the whole Space.
 * - `existing`   reply into a thread that already exists, addressed by its
 *                resource name `spaces/<space>/threads/<thread>`.
 */
export type ThreadMode = "per_alert" | "single" | "existing";

export interface ThreadTarget {
  mode?: ThreadMode;
  /** Fixed key for `single`. */
  key?: string;
  /** Resource name for `existing`. */
  name?: string;
}

function withThread(url: string, threadKey: string): string {
  const target = new URL(url);
  target.searchParams.set("threadKey", threadKey.slice(0, 512));
  target.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
  return target.toString();
}

function replyInExistingThread(url: string): string {
  const target = new URL(url);
  // The thread is addressed in the body; the query only states that this
  // message is a reply rather than a new conversation.
  target.searchParams.delete("threadKey");
  target.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
  return target.toString();
}

/** Resolve a route's thread setting into the URL and body fields to send. */
function applyThread(
  webhookUrl: string,
  body: Record<string, unknown>,
  thread: ThreadTarget | undefined,
  dedupKey: string,
): { url: string; body: Record<string, unknown> } {
  const mode = thread?.mode ?? "per_alert";
  if (mode === "existing" && thread?.name) {
    // Normalise again here: a config saved before thread links were canonical
    // still holds the pasted URL, and Google rejects that outright.
    const name = normalizeGoogleChatThreadName(thread.name);
    if (name) {
      return { url: replyInExistingThread(webhookUrl), body: { ...body, thread: { name } } };
    }
  }
  const key = mode === "single" && thread?.key ? thread.key : dedupKey;
  return { url: withThread(webhookUrl, key), body };
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
  return normalizeGoogleChatMentionIds(values)
    .map((value) => `<users/${mentionPingIdOf(value)}>`)
    .join(" ");
}

function addMentions(text: string, mentionTargets: string[]): string {
  const mentions = googleChatMentionText(mentionTargets);
  // The PIC line repeats the addresses as plain text. If Chat resolves the
  // mention the reader sees both the ping and who owns the warehouse; if it
  // does not resolve, ownership is still legible instead of silently lost.
  const emails = mentionEmailsOf(mentionTargets);
  const pic = emails.length ? `PIC: ${emails.join(", ")}` : "";
  return [mentions, pic, text].filter(Boolean).join("\n");
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

/**
 * Kartu alert.
 *
 * Disusun sependek mungkin dengan sengaja. Kartu ini muncul di Space yang juga
 * dipakai untuk percakapan lain, dibaca sambil lalu, dan yang harus sampai
 * hanya: lokasi mana, apa yang terjadi, dan apa tindakannya. Versi sebelumnya
 * mengulang informasi yang sama tiga kali — severity dan nama aturan di judul,
 * lokasi di subjudul, lalu judul alert yang menyebut lokasi itu lagi — sebelum
 * sampai ke kalimat yang benar-benar berisi. Nomor alert dan hitungan kejadian
 * ikut dibuang: keduanya hanya berguna setelah kartunya diklik, dan tombolnya
 * sudah menuju ke sana.
 */
export async function sendGChatAlert(
  webhookUrl: string,
  alert: Alert,
  escalationPrefix?: string,
  mentionTargets: string[] = [],
  thread?: ThreadTarget,
): Promise<GChatSendResult> {
  const base = process.env.APP_BASE_URL?.replace(/\/$/, "");
  const mentionEmails = mentionEmailsOf(mentionTargets);
  // Judul alert sudah memuat kode SLOC, jadi subjudul cukup menyebut cakupannya.
  const scope = [
    alert.warehouse_code,
    alert.zone ? `Zona ${alert.zone}` : null,
    escalationPrefix,
  ].filter(Boolean).join(" · ");
  const heading = `${SEV_ICON[alert.severity] ?? ""} ${alert.title}`.trim();
  const fallback = addMentions([heading, scope, alert.detail].join("\n"), mentionTargets);
  const card = {
    text: fallback,
    cardsV2: [{
      cardId: alert.alert_id,
      card: {
        header: { title: heading, subtitle: scope },
        sections: [{
          widgets: [
            { textParagraph: { text: escapeHtml(alert.detail) } },
            ...(mentionEmails.length ? [{
              textParagraph: { text: `<b>PIC:</b> ${escapeHtml(mentionEmails.join(", "))}` },
            }] : []),
            ...(base ? [{
              buttonList: { buttons: [{
                text: "Buka alert",
                onClick: { openLink: { url: `${base}/alerts?id=${encodeURIComponent(alert.alert_id)}` } },
              }] },
            }] : []),
          ],
        }],
      },
    }],
  };
  const target = applyThread(webhookUrl, card, thread, alert.dedup_key);
  return post(target.url, target.body);
}

/** Pesan teks polos untuk uji koneksi dan ringkasan. */
export async function sendGChatText(
  webhookUrl: string,
  text: string,
  threadKey?: string,
  mentionUserIds: string[] = [],
  thread?: ThreadTarget,
): Promise<GChatSendResult> {
  const body = { text: addMentions(text, mentionUserIds) };
  // A test send has to land exactly where real alerts will, otherwise it proves
  // the webhook works but not that the thread routing does.
  if (thread?.mode === "existing" && thread.name) {
    return post(replyInExistingThread(webhookUrl), { ...body, thread: { name: thread.name } });
  }
  const key = thread?.mode === "single" && thread.key ? thread.key : threadKey;
  return post(key ? withThread(webhookUrl, key) : webhookUrl, body);
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
