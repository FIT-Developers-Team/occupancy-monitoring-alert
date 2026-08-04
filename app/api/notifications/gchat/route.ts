import { NextRequest, NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getRecipients, getWarehouses } from "@/lib/config";
import { stateQuery } from "@/lib/db";
import { sendGChatText } from "@/lib/notify/gchat";
import {
  isGoogleChatWebhookUrl,
  normalizeGoogleChatMentionIds,
  redactGoogleChatWebhook,
} from "@/lib/notify/gchat-url";

interface NotificationLogRow {
  at: string;
  status: string;
  recipient: string;
  message: string;
}

async function admin() {
  const user = await currentUser();
  return user && isAdmin(user.role) ? user : null;
}

export async function GET() {
  const user = await admin();
  if (!user) return NextResponse.json({ error: "Khusus admin." }, { status: 403 });

  const [logs, config] = await Promise.all([
    stateQuery<NotificationLogRow>(
      `SELECT "at"::VARCHAR AS "at", status, recipient, message
       FROM notification_log WHERE channel = 'gchat'
       ORDER BY "at" DESC LIMIT 12`,
    ),
    Promise.resolve(getRecipients()),
  ]);
  const warehouses = getWarehouses().warehouses.map((warehouse) => warehouse.code);
  const enabledRoutes = config.levels.flatMap((level) =>
    level.gchat_routes.filter((route) => route.enabled).map((route) => ({ ...route, level: level.level })),
  );
  const coverage = Object.fromEntries(warehouses.map((warehouse) => [
    warehouse,
    enabledRoutes.filter((route) => route.warehouse_codes.includes("*") || route.warehouse_codes.includes(warehouse)).length,
  ]));

  return NextResponse.json({
    summary: {
      levels: config.levels.length,
      routes: config.levels.reduce((total, level) => total + level.gchat_routes.length, 0),
      enabled_routes: enabledRoutes.length,
      coverage,
    },
    logs,
  });
}

export async function POST(request: NextRequest) {
  const user = await admin();
  if (!user) return NextResponse.json({ error: "Khusus admin." }, { status: 403 });
  const body = await request.json().catch(() => null) as {
    webhook_url?: unknown;
    mention_targets?: unknown;
    /** Older clients still post the pre-email key. */
    mention_user_ids?: unknown;
    label?: unknown;
    warehouse_code?: unknown;
    level?: unknown;
  } | null;
  const webhookUrl = typeof body?.webhook_url === "string" ? body.webhook_url.trim() : "";
  if (!isGoogleChatWebhookUrl(webhookUrl)) {
    return NextResponse.json({ error: "URL incoming webhook Google Chat tidak valid." }, { status: 400 });
  }
  const mentionInput = Array.isArray(body?.mention_targets)
    ? body.mention_targets
    : Array.isArray(body?.mention_user_ids) ? body.mention_user_ids : [];
  const rawMentions = mentionInput.filter((value): value is string => typeof value === "string");
  const mentions = normalizeGoogleChatMentionIds(rawMentions);
  if (mentions.length !== new Set(rawMentions.map((value) => value.trim().replace(/^users\//i, "").toLowerCase())).size) {
    return NextResponse.json(
      { error: "Tag harus berupa email kerja, Google Chat user ID, atau 'all'." },
      { status: 400 },
    );
  }
  const label = typeof body?.label === "string" ? body.label.trim().slice(0, 80) : "Rute Google Chat";
  const warehouse = typeof body?.warehouse_code === "string" ? body.warehouse_code.trim().slice(0, 20) : "Semua WH";
  const level = Number.isFinite(Number(body?.level)) ? Number(body?.level) : 1;
  const text = [
    "*Uji koneksi FIT Occupancy Alert and Monitoring*",
    `Rute: ${label || "Google Chat"}`,
    `Cakupan: ${warehouse || "Semua WH"} · Level L${level}`,
    "Koneksi berhasil. Pesan ini bukan alert breach.",
  ].join("\n");
  const result = await sendGChatText(webhookUrl, text, undefined, mentions);
  await audit(
    user.username,
    "GCHAT_TEST",
    `notification:${redactGoogleChatWebhook(webhookUrl)}`,
    undefined,
    { ok: result.ok, status: result.status ?? null, label, warehouse, level },
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error ?? "Google Chat tidak merespons.", status: result.status ?? null },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, status: result.status ?? 200 });
}
