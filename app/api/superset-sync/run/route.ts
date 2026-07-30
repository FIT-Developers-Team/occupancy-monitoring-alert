import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  assertSupersetSyncCredentials,
  requestSupersetSync,
  SupersetSyncWorkerUnavailableError,
} from "@/lib/superset-sync";
import { ensureSupersetSyncWorker } from "@/lib/superset-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const user = await currentUser();
  if (!user || !isAdmin(user.role)) {
    return NextResponse.json({ error: "Khusus admin." }, { status: 403 });
  }
  try {
    assertSupersetSyncCredentials();
    const worker = await ensureSupersetSyncWorker();
    const request = requestSupersetSync(user.username);
    await audit(
      user.username,
      "SUPERSET_SYNC_REQUEST",
      "superset:sync",
      null,
      { ...request, worker_started: worker.started },
    );
    return NextResponse.json(
      { accepted: true, request, worker_started: worker.started },
      { status: 202 },
    );
  } catch (error) {
    const status = error instanceof SupersetSyncWorkerUnavailableError ? 503 : 409;
    return NextResponse.json({ error: (error as Error).message }, { status });
  }
}
