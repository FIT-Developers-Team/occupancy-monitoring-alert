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
    const runtimeStatus = getSupersetSyncStatus();
    // Polling this route used to reopen warehouse_history.duckdb every 2.5s
    // while the Python worker was trying to become the exclusive writer. On
    // Windows those status reads repeatedly won the file lock and made manual
    // sync fail. Runtime progress is file-backed, so defer DB history until the
    // queued/write window has finished.
    const writerBusy = runtimeStatus.state === "queued" || runtimeStatus.state === "running";
    const history = !writerBusy && historyDbExists()
      ? await getSyncHealth().catch(() => null)
      : null;
    return NextResponse.json({ status: runtimeStatus, history });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
