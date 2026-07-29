import { NextRequest, NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  getSupersetSyncSettings,
  writeSupersetSyncSettings,
} from "@/lib/superset-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user || !isAdmin(user.role)) {
    return NextResponse.json({ error: "Khusus admin." }, { status: 403 });
  }
  try {
    return NextResponse.json(getSupersetSyncSettings());
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const user = await currentUser();
  if (!user || !isAdmin(user.role)) {
    return NextResponse.json({ error: "Khusus admin." }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Body JSON tidak valid." }, { status: 400 });
  try {
    const before = getSupersetSyncSettings();
    const after = writeSupersetSyncSettings(body);
    await audit(
      user.username,
      "SUPERSET_SYNC_CONFIG_UPDATE",
      "config:superset-sync",
      {
        config: before.config,
        secret_state: before.secret_state,
      },
      {
        config: after.config,
        secret_state: after.secret_state,
      },
    );
    return NextResponse.json(after);
  } catch (error) {
    return NextResponse.json({ error: `Validasi gagal: ${(error as Error).message}` }, { status: 400 });
  }
}
