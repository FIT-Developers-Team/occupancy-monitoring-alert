// SOP-006: ringkasan harian 08:00 WIB — okupansi per gudang, alert aktif,
// horizon terdekat. Dikirim ke Level 1 & 2 (Google Chat/email bila dikonfigurasi).
import { NextRequest, NextResponse } from "next/server";
import { getWarehouseSummaries } from "@/lib/queries";
import { activeCountsBySeverity } from "@/lib/alerts/store";
import { getRecipients } from "@/lib/config";
import { sendGChatText } from "@/lib/notify/gchat";
import { normalizeGoogleChatMentionIds } from "@/lib/notify/gchat-url";
import { sendEmail } from "@/lib/notify/email";
import { fmtHours } from "@/lib/utils";

async function authorize(req: NextRequest): Promise<string | null> {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return process.env.CRON_SECRET && bearer === process.env.CRON_SECRET ? "cron" : null;
}

async function handle(req: NextRequest) {
  const actor = await authorize(req);
  if (!actor) return NextResponse.json({ error: "Tidak diizinkan." }, { status: 401 });

  const [sums, counts] = await Promise.all([getWarehouseSummaries(), activeCountsBySeverity()]);
  const tanggal = new Date().toLocaleDateString("id-ID", {
    weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Jakarta",
  });

  const lines: string[] = [`📊 <b>Ringkasan Harian FIT Occupancy Alert and Monitoring — ${tanggal}</b>`, ""];
  for (const s of [...sums].sort((a, b) => b.pct - a.pct)) {
    const icon =
      s.status === "BREACH" || s.status === "CRITICAL" ? "🔴"
      : s.status === "WARNING" ? "🟠" : s.status === "MONITOR" ? "🟡" : "🟢";
    const horizon = s.hours_to_95 !== null ? ` · →95% ${fmtHours(s.hours_to_95)}` : "";
    lines.push(`${icon} <b>${s.code}</b> ${s.pct}% ${s.basis.toUpperCase()} (${s.sloc_empty} SLOC kosong)${horizon}`);
  }
  const totalActive = Object.values(counts).reduce((a, b) => a + b, 0);
  lines.push("", `🔔 Alert aktif: <b>${totalActive}</b>` +
    (totalActive
      ? ` (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")})`
      : " — tidak ada."));
  const text = lines.join("\n");

  const cfg = getRecipients();
  let sent = 0;
  for (const lv of cfg.levels.filter((l) => l.level <= 2)) {
    const chatTargets = new Map<string, string[]>();
    for (const route of lv.gchat_routes) {
      // A full-network summary must not leak other WH metrics into a Space
      // explicitly scoped to one warehouse. Only global routes receive it.
      if (!route.enabled || !route.warehouse_codes.includes("*")) continue;
      chatTargets.set(route.webhook_url, normalizeGoogleChatMentionIds([
        ...(chatTargets.get(route.webhook_url) ?? []),
        ...route.mention_user_ids,
      ]));
    }
    for (const webhookUrl of lv.gchat_webhooks) {
      if (!chatTargets.has(webhookUrl)) chatTargets.set(webhookUrl, []);
    }
    for (const [webhookUrl, mentions] of chatTargets) {
      if ((await sendGChatText(
        webhookUrl,
        text.replace(/<\/?b>/g, "*"),
        "fit-occupancy-daily",
        mentions,
      )).ok) sent++;
    }
    for (const em of lv.emails) {
      if ((await sendEmail(em, `Ringkasan Harian FIT Occupancy Alert and Monitoring — ${tanggal}`, text.replace(/<[^>]+>/g, ""))).ok) sent++;
    }
  }
  return NextResponse.json({ ok: true, sent, preview: text });
}

export async function POST(req: NextRequest) { return handle(req); }
