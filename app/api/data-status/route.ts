import { NextResponse } from "next/server";
import { historyDbVersion } from "@/lib/db";
import { getSupersetSyncStatus } from "@/lib/superset-sync";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = getSupersetSyncStatus();
    return NextResponse.json({
      state: status.state,
      phase: status.phase ?? null,
      updatedAt: status.finished_at ?? status.updated_at ?? null,
      workerOnline: status.worker.online,
      workerReady: status.worker.ready,
      hasSnapshot: historyDbVersion() !== "missing",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      state: "failed",
      workerOnline: false,
      workerReady: false,
      hasSnapshot: historyDbVersion() !== "missing",
      error: (error as Error).message,
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
