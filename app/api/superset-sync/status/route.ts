import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { historyDbExists } from "@/lib/db";
import { getSyncHealth } from "@/lib/queries";
import { getSupersetSyncStatus } from "@/lib/superset-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user || !isAdmin(user.role)) {
    return NextResponse.json({ error: "Khusus admin." }, { status: 403 });
  }
  try {
    const [runtimeStatus, history] = await Promise.all([
      Promise.resolve(getSupersetSyncStatus()),
      historyDbExists() ? getSyncHealth().catch(() => null) : Promise.resolve(null),
    ]);
    return NextResponse.json({ status: runtimeStatus, history });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
