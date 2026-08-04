// Google Chat incoming webhook — real-time saat alert tercipta/eskalasi.
// threadKey = dedup_key alert → update alert yang sama tergabung 1 thread.
import type { Alert } from "@/types";

const SEV_EMOJI: Record<string, string> = {
  INFO: "ℹ️", WARNING: "🟡", HIGH: "🟠", CRITICAL: "🔴", EMERGENCY: "🚨",
};

function withThread(url: string, threadKey: string): string {
  const u = new URL(url);
  u.searchParams.set("threadKey", threadKey);
  u.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
  return u.toString();
}

async function post(url: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    if (res.ok) return { ok: true };
    const t = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status} ${t.slice(0, 160)}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Kartu alert (cardsV2) + tombol link ke aplikasi. */
export async function sendGChatAlert(
  webhookUrl: string, a: Alert, escalationPrefix?: string
): Promise<{ ok: boolean; error?: string }> {
  const base = process.env.APP_BASE_URL?.replace(/\/$/, "");
  const loc = [a.warehouse_code, a.zone ? `Zona ${a.zone}` : null, a.sloc_code, a.sku]
    .filter(Boolean).join(" · ");
  const card = {
    text: `${SEV_EMOJI[a.severity] ?? ""} [${a.severity}] ${a.rule_name} — ${loc}`, // fallback notif
    cardsV2: [{
      cardId: a.alert_id,
      card: {
        header: {
          title: `${SEV_EMOJI[a.severity] ?? ""} [${a.severity}] ${a.rule_name}${escalationPrefix ? ` — ${escalationPrefix}` : ""}`,
          subtitle: loc,
        },
        sections: [{
          widgets: [
            { textParagraph: { text: `<b>${a.title}</b>` } },
            { textParagraph: { text: a.detail } },
            { textParagraph: { text: `<i>Alert ${a.alert_id} · kejadian ke-${a.occurrences}</i>` } },
            ...(base ? [{
              buttonList: { buttons: [{
                text: "Buka FIT Occupancy Alert and Monitoring — Ack / Resolve",
                onClick: { openLink: { url: `${base}/alerts` } },
              }] },
            }] : []),
          ],
        }],
      },
    }],
  };
  return post(withThread(webhookUrl, a.dedup_key), card);
}

/** Pesan teks polos (ringkasan harian dll). */
export async function sendGChatText(
  webhookUrl: string, text: string, threadKey?: string
): Promise<{ ok: boolean; error?: string }> {
  const url = threadKey ? withThread(webhookUrl, threadKey) : webhookUrl;
  return post(url, { text });
}

/** Webhook generik: POST JSON alert apa adanya (n8n / Apps Script / tiket internal). */
export async function sendGenericWebhook(
  url: string, a: Alert, escalationPrefix?: string
): Promise<{ ok: boolean; error?: string }> {
  return post(url, { source: "wiom", escalation: escalationPrefix ?? null, alert: a });
}
