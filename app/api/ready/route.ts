import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { sessionSecretStatus } from "@/lib/session-secret";
import {
  getSupersetSyncConfig,
  getSupersetSyncStatus,
} from "@/lib/superset-sync";
import { accountStoreStatus } from "@/lib/account-store";
import { configStorageInfo } from "@/lib/runtime-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, unknown> = {};
  let ready = true;

  const session = sessionSecretStatus();
  checks.authentication = session.configured ? "ok" : session.reason;
  ready = ready && session.configured;

  const accounts = accountStoreStatus();
  checks.accounts = accounts.error
    ? { status: "error", error: accounts.error }
    : { status: accounts.ready ? "ok" : "error", active_admins: accounts.activeAdmins };
  ready = ready && accounts.ready;

  // Deployment yang tidak dapat menyimpan konfigurasi secara permanen akan
  // kehilangan setiap penyetelan admin pada rilis berikutnya. Itu kondisi tidak
  // siap, bukan sekadar catatan — ditandai di sini agar ketahuan saat deploy.
  //
  // Endpoint ini TIDAK dipakai healthcheck container (lihat /api/live). Ia
  // boleh menjawab 503 sekeras-kerasnya tanpa membuat container digulung balik,
  // sehingga diagnosisnya dapat dibaca justru saat deployment bermasalah.
  const configStorage = configStorageInfo();
  checks.config_storage = configStorage.durable
    ? {
        status: "ok",
        persisted: configStorage.persisted.length,
        persistent_mount: configStorage.persistentMount,
      }
    : {
        status: "error",
        code: !configStorage.writable
          ? "CONFIG_STORAGE_NOT_WRITABLE"
          : configStorage.durabilityRequired && configStorage.persistentMount !== true
            ? "PERSISTENT_STORAGE_MISSING"
            : "CONFIG_STORAGE_NOT_DURABLE",
        writable: configStorage.writable,
        persistent_mount: configStorage.persistentMount,
        mount_required: configStorage.durabilityRequired,
        mount_enforced: configStorage.durabilityEnforced,
        // Satu kalimat tindakan, bukan sekadar status: inilah yang dibaca
        // operator di log deploy ketika sesuatu tidak beres.
        fix: configStorage.writable
          ? "Pasang penyimpanan permanen ke /app/db (Coolify: Storages → Add → Mount Path /app/db), lalu deploy ulang."
          : "Folder konfigurasi tidak dapat ditulis; periksa izin volume /app/db.",
        reason: configStorage.reason,
      };
  ready = ready && configStorage.durable;

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
