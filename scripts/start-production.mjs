import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import nextEnv from "@next/env";

if (process.env.WIOM_SKIP_ENV_FILE !== "1") {
  nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
}

const PLACEHOLDER = /^(change-me|dev-only|example|generate-|your-|replace-|todo)/i;

function clean(value) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  return quoted ? trimmed.slice(1, -1).trim() : trimmed;
}

function valid(value) {
  return Boolean(value && value.length >= 32 && !PLACEHOLDER.test(value));
}

function configuredSecret() {
  return [
    clean(process.env.SESSION_SECRET),
    clean(process.env.AUTH_SECRET),
    clean(process.env.NEXTAUTH_SECRET),
  ].find(valid);
}

function secretFilePath() {
  if (process.env.SESSION_SECRET_FILE?.trim()) {
    return path.resolve(process.env.SESSION_SECRET_FILE.trim());
  }
  const stateDb = process.env.DUCKDB_STATE_PATH?.trim() || "./db/app_state.duckdb";
  return path.join(path.dirname(path.resolve(stateDb)), ".wiom-session-secret");
}

function readSecret(file) {
  try {
    const value = clean(fs.readFileSync(file, "utf8"));
    if (!valid(value)) {
      throw new Error(`Secret sesi tersimpan di ${file} tidak valid.`);
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function createPersistentSecret(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const value = randomBytes(48).toString("base64url");
  try {
    fs.writeFileSync(file, `${value}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return value;
  } catch (error) {
    // Another process may have won a simultaneous first-start race.
    if (error?.code === "EEXIST") return readSecret(file);
    throw error;
  }
}

function prepareSessionSecret() {
  const explicit = configuredSecret();
  if (explicit) {
    process.env.WIOM_SESSION_SECRET_ORIGIN = "environment";
    return;
  }

  const file = secretFilePath();
  try {
    const persisted = readSecret(file) || createPersistentSecret(file);
    process.env.SESSION_SECRET = persisted;
    process.env.WIOM_SESSION_SECRET_ORIGIN = "persistent-file";
    console.info(`[WIOM] Secret sesi dimuat dari penyimpanan server: ${file}`);
  } catch (error) {
    // Read-only serverless filesystems can still run securely with an
    // in-memory random secret, but sessions will reset on process restart.
    process.env.SESSION_SECRET = randomBytes(48).toString("base64url");
    process.env.WIOM_SESSION_SECRET_ORIGIN = "ephemeral-memory";
    console.warn(
      `[WIOM] Penyimpanan secret tidak dapat ditulis (${error.message}). ` +
      "Memakai secret sementara; konfigurasi SESSION_SECRET tetap dianjurkan."
    );
  }
}

prepareSessionSecret();

function embeddedSyncEnabled() {
  const value = process.env.WIOM_EMBEDDED_SYNC?.trim().toLowerCase();
  return !["0", "false", "off", "disabled"].includes(value || "");
}

function embeddedSyncRequired() {
  if (process.argv.includes("--sync-optional")) return false;
  const value = process.env.WIOM_SYNC_REQUIRED?.trim().toLowerCase();
  return ["1", "true", "on", "required"].includes(value || "");
}

function findPython() {
  const explicit = clean(process.env.WIOM_SYNC_PYTHON);
  const candidates = explicit
    ? [explicit]
    : process.platform === "win32"
      ? ["python.exe", "python3.exe", "py.exe"]
      : ["python3", "python"];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "ignore",
      timeout: 3_000,
    });
    if (result.error || result.status !== 0) continue;
    const dependencies = spawnSync(
      candidate,
      ["-c", "import duckdb, pandas, requests"],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: "ignore",
        timeout: 10_000,
      }
    );
    if (!dependencies.error && dependencies.status === 0) return candidate;
  }
  return undefined;
}

function syncHeartbeatPath() {
  const configFile = path.resolve(
    clean(process.env.WIOM_SYNC_CONFIG) || "config/superset-sync.json"
  );
  try {
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    return path.resolve(
      clean(config?.control?.heartbeat_file) || "db/.superset-sync-heartbeat.json"
    );
  } catch {
    return path.resolve("db/.superset-sync-heartbeat.json");
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readReadyHeartbeat(file) {
  try {
    const heartbeat = JSON.parse(fs.readFileSync(file, "utf8"));
    const timestamp = Date.parse(heartbeat?.heartbeat_at);
    const fresh = Number.isFinite(timestamp) && Date.now() - timestamp < 20_000;
    return fresh && heartbeat?.ready === true && pidAlive(Number(heartbeat?.pid))
      ? heartbeat
      : undefined;
  } catch {
    return undefined;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function startSyncSupervisor() {
  const required = embeddedSyncRequired();
  if (!embeddedSyncEnabled()) {
    if (required) {
      throw new Error(
        "WIOM_SYNC_REQUIRED aktif tetapi WIOM_EMBEDDED_SYNC dinonaktifkan."
      );
    }
    console.info("[WIOM] Worker Superset terpisah dipilih; embedded sync dinonaktifkan.");
    return undefined;
  }

  const script = path.join(process.cwd(), "scripts", "superset_to_duckdb.py");
  if (!fs.existsSync(script)) {
    const message = "Worker Superset tidak dimulai: script sinkronisasi tidak tersedia.";
    if (required) throw new Error(message);
    console.warn(`[WIOM] ${message}`);
    return undefined;
  }
  const python = findPython();
  if (!python) {
    const message =
      "Worker Superset tidak dimulai: Python 3 atau dependency " +
      "duckdb/pandas/requests tidak tersedia.";
    if (required) throw new Error(message);
    console.warn(`[WIOM] ${message} Gunakan image Docker terbaru atau service sync terpisah.`);
    return undefined;
  }

  const config = path.resolve(
    clean(process.env.WIOM_SYNC_CONFIG) || "config/superset-sync.json"
  );
  const runtimeCheck = spawnSync(
    python,
    [script, "--config", config, "--check-runtime"],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      timeout: 15_000,
    }
  );
  if (runtimeCheck.error || runtimeCheck.status !== 0) {
    const message = runtimeCheck.error
      ? `Preflight worker Superset gagal: ${runtimeCheck.error.message}`
      : `Preflight worker Superset gagal (exit ${runtimeCheck.status ?? "?"}).`;
    if (required) throw new Error(message);
    console.warn(`[WIOM] ${message}`);
    return undefined;
  }
  let syncChild;
  let restartTimer;
  let stopping = false;
  let restartDelay = 5_000;
  let launchedAt = 0;
  let lastError;
  const heartbeatFile = syncHeartbeatPath();

  // A heartbeat persisted on the volume may belong to a container/process that
  // no longer exists. Removing only a dead-owner heartbeat avoids a false-ready
  // deployment while preserving a worker bootstrapped by the running web app.
  try {
    const current = JSON.parse(fs.readFileSync(heartbeatFile, "utf8"));
    if (!pidAlive(Number(current?.pid))) fs.rmSync(heartbeatFile);
  } catch {
    // No heartbeat is a normal first-start condition.
  }

  const launch = () => {
    if (stopping) return;
    if (readReadyHeartbeat(heartbeatFile)) {
      restartTimer = setTimeout(launch, 10_000);
      restartTimer.unref?.();
      return;
    }
    launchedAt = Date.now();
    lastError = undefined;
    syncChild = spawn(
      python,
      [script, "--config", config, "--daemon"],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
      }
    );
    console.info(`[WIOM] Worker Superset aktif (pid ${syncChild.pid ?? "?"}).`);
    syncChild.on("error", (error) => {
      lastError = error;
      console.error(`[WIOM] Worker Superset gagal dijalankan: ${error.message}`);
    });
    syncChild.on("exit", (code, signal) => {
      if (stopping) return;
      const runtime = Date.now() - launchedAt;
      restartDelay = runtime >= 60_000
        ? 5_000
        : Math.min(restartDelay * 2, 60_000);
      console.error(
        `[WIOM] Worker Superset berhenti (${signal || `code ${code ?? "?"}`}); ` +
        `mencoba lagi dalam ${Math.round(restartDelay / 1_000)} detik.`
      );
      restartTimer = setTimeout(launch, restartDelay);
      restartTimer.unref?.();
    });
  };

  launch();
  return {
    async waitUntilReady(timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (readReadyHeartbeat(heartbeatFile)) return;
        if (lastError) throw lastError;
        await delay(250);
      }
      let detail = "";
      try {
        const heartbeat = JSON.parse(fs.readFileSync(heartbeatFile, "utf8"));
        detail = heartbeat?.error ? `: ${heartbeat.error}` : "";
      } catch {
        // Keep the deployment error concise when no heartbeat was created.
      }
      throw new Error(`Worker Superset tidak siap dalam ${timeoutMs / 1_000} detik${detail}.`);
    },
    stop(signal = "SIGTERM") {
      stopping = true;
      if (restartTimer) clearTimeout(restartTimer);
      if (syncChild && !syncChild.killed) syncChild.kill(signal);
    },
  };
}

function commandLineValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? clean(process.argv[index + 1]) : undefined;
}

const syncSupervisor = startSyncSupervisor();
if (embeddedSyncRequired()) {
  await syncSupervisor.waitUntilReady();
  console.info("[WIOM] Worker Superset siap; web server dapat menerima trafik.");
}
const port = commandLineValue("--port") || process.env.PORT?.trim() || "3000";
if (!/^\d{2,5}$/.test(port) || Number(port) > 65_535) {
  syncSupervisor?.stop();
  throw new Error(`Port tidak valid: ${port}`);
}
const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "start", "-p", port], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    syncSupervisor?.stop(signal);
    child.kill(signal);
  });
}

child.on("error", (error) => {
  syncSupervisor?.stop();
  console.error(`[WIOM] Gagal menjalankan Next.js: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  syncSupervisor?.stop(signal || "SIGTERM");
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
