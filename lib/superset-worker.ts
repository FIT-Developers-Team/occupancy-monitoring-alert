import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  getSupersetSyncStatus,
  SupersetSyncWorkerUnavailableError,
} from "@/lib/superset-sync";

const ROOT = process.cwd();
const DB_DIR = path.join(ROOT, "db");
const SCRIPT_FILE = path.join(ROOT, "scripts", "superset_to_duckdb.py");
const DEFAULT_CONFIG_FILE = path.join(ROOT, "config", "superset-sync.json");
const BOOTSTRAP_LOCK_FILE = path.join(DB_DIR, ".superset-sync-bootstrap.lock");
const BOOTSTRAP_LOCK_STALE_MS = 30_000;

function enabledByDefault(value: string | undefined): boolean {
  return !["0", "false", "off", "disabled"].includes(value?.trim().toLowerCase() || "");
}

function pythonCandidates(): string[] {
  const explicit = process.env.WIOM_SYNC_PYTHON?.trim();
  if (explicit) return [explicit];
  return process.platform === "win32"
    ? ["python.exe", "python3.exe", "py.exe"]
    : ["python3", "python"];
}

function findSyncPython(): string | null {
  for (const candidate of pythonCandidates()) {
    const version = spawnSync(candidate, ["--version"], {
      cwd: ROOT,
      env: process.env,
      stdio: "ignore",
      timeout: 3_000,
      windowsHide: true,
    });
    if (version.error || version.status !== 0) continue;
    const imports = spawnSync(candidate, ["-c", "import duckdb, pandas, requests"], {
      cwd: ROOT,
      env: process.env,
      stdio: "ignore",
      timeout: 10_000,
      windowsHide: true,
    });
    if (!imports.error && imports.status === 0) return candidate;
  }
  return null;
}

function verifySyncRuntime(python: string): void {
  const config = path.resolve(process.env.WIOM_SYNC_CONFIG?.trim() || DEFAULT_CONFIG_FILE);
  const result = spawnSync(
    python,
    [SCRIPT_FILE, "--config", config, "--check-runtime", "--check-auth"],
    {
      cwd: ROOT,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      windowsHide: true,
    },
  );
  if (!result.error && result.status === 0) return;
  const diagnostic = `${result.stderr || result.stdout || ""}`
    .trim()
    .split(/\r?\n/)
    .at(-1);
  throw new SupersetSyncWorkerUnavailableError(
    diagnostic
      ? `Preflight worker gagal: ${diagnostic.slice(0, 500)}`
      : "Preflight worker Superset gagal. Periksa konfigurasi dan izin folder db.",
  );
}

function acquireBootstrapLock(): boolean {
  fs.mkdirSync(DB_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(BOOTSTRAP_LOCK_FILE, "wx", 0o600);
      fs.writeFileSync(handle, `${process.pid}|${Date.now()}\n`);
      fs.closeSync(handle);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const age = Date.now() - fs.statSync(BOOTSTRAP_LOCK_FILE).mtimeMs;
        if (age <= BOOTSTRAP_LOCK_STALE_MS) return false;
        fs.rmSync(BOOTSTRAP_LOCK_FILE);
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
    }
  }
  return false;
}

function releaseBootstrapLock(): void {
  try {
    fs.rmSync(BOOTSTRAP_LOCK_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[WIOM] Bootstrap lock tidak dapat dihapus: ${(error as Error).message}`);
    }
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const worker = getSupersetSyncStatus().worker;
      if (worker.online && worker.ready) return true;
    } catch {
      // The daemon may still be loading the configuration. Keep polling until
      // the bounded deadline so a transient partial startup is not reported.
    }
    await wait(250);
  }
  return false;
}

async function spawnDaemon(python: string): Promise<number | undefined> {
  const config = path.resolve(process.env.WIOM_SYNC_CONFIG?.trim() || DEFAULT_CONFIG_FILE);
  const child = spawn(
    python,
    [SCRIPT_FILE, "--config", config, "--daemon"],
    {
      cwd: ROOT,
      env: process.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timeout saat memulai worker sinkronisasi.")),
      3_000,
    );
    child.once("spawn", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  child.unref();
  return child.pid;
}

export interface SupersetWorkerBootstrapResult {
  ready: true;
  started: boolean;
  pid?: number;
}

/**
 * Ensure a managed Superset daemon is ready before accepting a manual run.
 *
 * `npm start` remains the primary supervisor. This bounded bootstrap is the
 * recovery path for deployments that invoke `next start` directly or for a
 * worker that exited while the web process stayed alive.
 */
export async function ensureSupersetSyncWorker(
  timeoutMs = 15_000,
): Promise<SupersetWorkerBootstrapResult> {
  const current = getSupersetSyncStatus().worker;
  if (current.online && current.ready) {
    return { ready: true, started: false };
  }
  if (!enabledByDefault(process.env.WIOM_API_SYNC_BOOTSTRAP)) {
    throw new SupersetSyncWorkerUnavailableError(
      "Worker sinkronisasi tidak aktif dan bootstrap API dinonaktifkan.",
    );
  }
  if (!fs.existsSync(SCRIPT_FILE)) {
    throw new SupersetSyncWorkerUnavailableError(
      "Script worker Superset tidak tersedia pada image deployment.",
    );
  }

  const ownsLock = acquireBootstrapLock();
  let pid: number | undefined;
  try {
    if (ownsLock) {
      const python = findSyncPython();
      if (!python) {
        throw new SupersetSyncWorkerUnavailableError(
          "Python 3 atau dependency sync (duckdb, pandas, requests) tidak tersedia. "
          + "Gunakan Dockerfile terbaru atau instal scripts/requirements.txt.",
        );
      }
      verifySyncRuntime(python);
      pid = await spawnDaemon(python);
    }

    if (await waitForReady(timeoutMs)) {
      return { ready: true, started: ownsLock, pid };
    }
    const latest = getSupersetSyncStatus().worker;
    throw new SupersetSyncWorkerUnavailableError(
      latest.error
        ? `Worker gagal siap: ${latest.error}`
        : ownsLock
          ? "Worker berhasil dimulai tetapi heartbeat belum siap dalam 15 detik."
          : "Bootstrap worker sedang berjalan tetapi heartbeat belum siap dalam 15 detik.",
    );
  } catch (error) {
    if (error instanceof SupersetSyncWorkerUnavailableError) throw error;
    throw new SupersetSyncWorkerUnavailableError(
      `Worker sinkronisasi gagal dimulai: ${(error as Error).message}`,
    );
  } finally {
    if (ownsLock) releaseBootstrapLock();
  }
}
