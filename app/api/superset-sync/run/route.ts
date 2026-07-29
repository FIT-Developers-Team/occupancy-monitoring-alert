import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { requestSupersetSync } from "@/lib/superset-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const user = await currentUser();
  if (!user || !isAdmin(user.role)) {
    return NextResponse.json({ error: "Khusus admin." }, { status: 403 });
  }
  try {
    const request = requestSupersetSync(user.username);
    await audit(user.username, "SUPERSET_SYNC_REQUEST", "superset:sync", null, request);
    return NextResponse.json({ accepted: true, request }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 409 });
  }
}
