import { NextRequest, NextResponse } from "next/server";
import { runTick } from "@/lib/alerts/engine";
import { canWrite, currentUser } from "@/lib/auth";

async function authorize(req: NextRequest): Promise<string | null> {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (process.env.CRON_SECRET && bearer === process.env.CRON_SECRET) return "cron";
  const user = await currentUser();
  return user && canWrite(user.role) ? user.username : null;
}

async function handle(req: NextRequest) {
  const actor = await authorize(req);
  if (!actor) return NextResponse.json({ error: "Tidak diizinkan." }, { status: 401 });
  try {
    const result = await runTick(actor);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) { return handle(req); }
