import { NextRequest, NextResponse } from "next/server";
import { currentUser, canWrite } from "@/lib/auth";
import { transitionAlert } from "@/lib/alerts/store";
import { audit } from "@/lib/audit";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Tidak terautentikasi." }, { status: 401 });
  if (!canWrite(user.role)) {
    return NextResponse.json({ error: "Role viewer tidak dapat melakukan aksi ini." }, { status: 403 });
  }
  const { id } = await ctx.params;
  const { note } = await req.json().catch(() => ({ note: "" }));
  const a = await transitionAlert(id, "ACKNOWLEDGED", user.username, note ?? "");
  if (!a) return NextResponse.json({ error: "Alert tidak ditemukan." }, { status: 404 });
  await audit(user.username, "ALERT_ACK", `alert:${id}`);
  return NextResponse.json({ alert: a });
}
