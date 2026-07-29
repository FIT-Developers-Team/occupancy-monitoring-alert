// Webhook Telegram: tombol inline Ack / Selesai / FP pada pesan alert.
// Amankan dengan secret token saat setWebhook (lihat README).
import { NextRequest, NextResponse } from "next/server";
import { transitionAlert } from "@/lib/alerts/store";
import { answerCallback } from "@/lib/notify/telegram";
import { audit } from "@/lib/audit";

export async function POST(req: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Webhook belum dikonfigurasi." }, { status: 403 });
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ error: "Secret token tidak cocok." }, { status: 403 });
  }
  const update = await req.json().catch(() => null);
  const cb = update?.callback_query;
  if (!cb?.data) return NextResponse.json({ ok: true });

  const [verb, alertId] = String(cb.data).split(":");
  const actor = `tg:${cb.from?.username || cb.from?.id || "unknown"}`;
  const map: Record<string, "ACKNOWLEDGED" | "RESOLVED" | "FALSE_POSITIVE"> = {
    ack: "ACKNOWLEDGED", res: "RESOLVED", fp: "FALSE_POSITIVE",
  };
  const action = map[verb];
  if (action && alertId) {
    const a = await transitionAlert(alertId, action, actor, "via Telegram");
    await audit(actor, `ALERT_${action}`, `alert:${alertId}`);
    await answerCallback(
      cb.id,
      a
        ? action === "ACKNOWLEDGED" ? "Alert di-ack ✅"
          : action === "RESOLVED" ? "Alert diselesaikan ✔"
          : "Ditandai false positive ⚠"
        : "Alert tidak ditemukan."
    );
  } else {
    await answerCallback(cb.id, "Perintah tidak dikenal.");
  }
  return NextResponse.json({ ok: true });
}
