import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { sessionSecretStatus } from "@/lib/session-secret";
import {
  getSupersetSyncConfig,
  getSupersetSyncStatus,
} from "@/lib/superset-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, unknown> = {};
  let ready = true;

  const session = sessionSecretStatus();
  checks.authentication = session.configured ? "ok" : session.reason;
  ready = ready && session.configured;

  try {
    const config = getSupersetSyncConfig();
    const status = getSupersetSyncStatus();
    const dbDirectory = path.dirname(path.resolve(process.cwd(), config.duckdb_path));
    fs.accessSync(dbDirectory, fs.constants.R_OK | fs.constants.W_OK);

    const workerReady = !config.schedule.enabled
      || (status.worker.online && status.worker.ready);
    checks.storage = "ok";
    checks.superset_worker = {
      required: config.schedule.enabled,
      online: status.worker.online,
      ready: status.worker.ready,
      heartbeat_at: status.worker.heartbeat_at,
      error: status.worker.error,
    };
    ready = ready && workerReady;
  } catch (error) {
    checks.superset_worker = { error: (error as Error).message };
    ready = false;
  }

  return NextResponse.json(
    { status: ready ? "ready" : "not_ready", checks },
    { status: ready ? 200 : 503 },
  );
}
