// Telegram channel: alert + inline buttons Ack/Resolve/FP (callback ke webhook).
export async function sendTelegram(
  chatId: string,
  text: string,
  alertId?: string
): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: "TELEGRAM_BOT_TOKEN belum di-set" };
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (alertId) {
    body.reply_markup = {
      inline_keyboard: [[
        { text: "✅ Ack", callback_data: `ack:${alertId}` },
        { text: "✔ Selesai", callback_data: `res:${alertId}` },
        { text: "⚠ False Positive", callback_data: `fp:${alertId}` },
      ]],
    };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await res.json()) as { ok: boolean; description?: string };
    return j.ok ? { ok: true } : { ok: false, error: j.description || "telegram error" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function answerCallback(callbackId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId, text }),
    });
  } catch { /* best effort */ }
}
