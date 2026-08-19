import { NextResponse } from "next/server";
import { historyDbExists, stateQuery } from "@/lib/db";
import { getSyncHealth } from "@/lib/queries";
import { getThresholds, getRules, getRecipients, getWarehouses, getCapacity } from "@/lib/config";
import { sessionSecretStatus } from "@/lib/session-secret";
import { getSupersetSyncConfig, getSupersetSyncStatus } from "@/lib/superset-sync";
import { accountStoreStatus } from "@/lib/account-store";
import { configStorageInfo } from "@/lib/runtime-config";

export async function GET() {
  const checks: Record<string, unknown> = { history_db: historyDbExists() };
  const session = sessionSecretStatus();
  checks.authentication = session.configured
    ? {
        status: "ok",
        source: session.source,
        origin: process.env.WIOM_SESSION_SECRET_ORIGIN || "environment",
      }
    : { status: "error", reason: session.reason, required: "SESSION_SECRET or AUTH_SECRET" };
  const accounts = accountStoreStatus();
  checks.accounts = accounts.error
    ? { status: "error", error: accounts.error }
    : { status: accounts.ready ? "ok" : "error", active_admins: accounts.activeAdmins };
  try {
    getThresholds(); getRules(); getRecipients(); getWarehouses(); getCapacity();
    checks.config = "ok";
    // Persistensi konfigurasi adalah bagian dari kesehatan deployment: bila
    // folder runtime tidak dapat ditulis, setiap penyimpanan admin akan hilang
    // pada deploy berikutnya, dan itu harus terlihat sebelum kejadian.
    // Endpoint ini terbuka tanpa login (lihat PUBLIC_PREFIXES di proxy.ts),
    // jadi yang dilaporkan hanya bentuk masalahnya — bukan path di server.
    const storage = configStorageInfo();
    checks.config_storage = {
      writable: storage.writable,
      persisted: storage.persisted.length,
      using_image_defaults: storage.usingSeed.length,
      reason: storage.reason,
    };
  } catch (e) {
    checks.config = `error: ${(e as Error).message}`;
  }
  try {
    const syncConfig = getSupersetSyncConfig();
    const syncStatus = getSupersetSyncStatus();
    checks.superset_sync = {
      configured: true,
      enabled: syncConfig.schedule.enabled,
      state: syncStatus.state,
      worker_online: syncStatus.worker.online,
      worker_ready: syncStatus.worker.ready,
      heartbeat_at: syncStatus.worker.heartbeat_at,
      finished_at: syncStatus.finished_at ?? null,
      next_run_at: syncStatus.next_run_at ?? null,
    };
  } catch (e) {
    checks.superset_sync = { configured: false, error: (e as Error).message };
  }
  if (checks.history_db) {
    try {
      const h = await getSyncHealth();
      checks.last_snapshot = h.last_snapshot;
      checks.snapshot_rows = h.snapshot_rows;
      if (h.last_snapshot) {
        const ageMin = Math.round((Date.now() - +new Date(h.last_snapshot)) / 60000);
        checks.snapshot_age_minutes = ageMin;
        checks.snapshot_fresh = ageMin <= 30;
      }
    } catch (e) {
      checks.history_query = `error: ${(e as Error).message}`;
    }
  }
  try {
    await stateQuery("SELECT 1 AS ok");
    checks.state_db = "ok";
  } catch (e) {
    checks.state_db = `error: ${(e as Error).message}`;
  }
  const healthy = checks.history_db === true
    && session.configured
    && accounts.ready
    && checks.config === "ok"
    && checks.state_db === "ok"
    && checks.snapshot_fresh === true;
  return NextResponse.json(
    { status: healthy ? "ok" : "degraded", checks },
    { status: healthy ? 200 : 503 }
  );
}
