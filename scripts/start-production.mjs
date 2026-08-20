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

/**
 * Satukan seluruh state yang harus tahan redeploy di sekitar state DuckDB.
 * Ini harus dilakukan sebelum worker maupun server Next dibuat agar Node dan
 * Python menerima keputusan path yang sama lewat environment.
 */
function preparePersistentPaths() {
  const stateDb = path.resolve(
    clean(process.env.DUCKDB_STATE_PATH) || "./db/app_state.duckdb"
  );
  process.env.DUCKDB_STATE_PATH = stateDb;
  if (!clean(process.env.WIOM_RUNTIME_CONFIG_DIR)) {
    process.env.WIOM_RUNTIME_CONFIG_DIR = path.join(
      path.dirname(stateDb),
      "runtime-config",
    );
  }
}

preparePersistentPaths();

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

function cronSecretFilePath() {
  const stateDb = process.env.DUCKDB_STATE_PATH?.trim() || "./db/app_state.duckdb";
  return path.join(path.dirname(path.resolve(stateDb)), ".wiom-cron-secret");
}

/**
 * Siapkan CRON_SECRET tanpa langkah manual.
 *
 * Tanpa secret ini scheduler bawaan mati, dan alert tidak pernah dievaluasi
 * sama sekali — persis yang terjadi pada deployment terakhir ("CRON_SECRET
 * belum diisi; evaluasi alert terjadwal dinonaktifkan"). Karena secret ini
 * hanya dipakai untuk memanggil endpoint cron milik sendiri di 127.0.0.1,
 * nilainya tidak perlu dipilih manusia; yang penting ia SAMA antara pemanggil
 * dan handler, dan tetap sama setelah deploy ulang.
 *
 * Disimpan di sebelah state DuckDB, mengikuti pola secret sesi: satu volume
 * permanen, satu keputusan path. Operator yang punya cron eksternal tetap
 * memakai CRON_SECRET dari environment dan nilainya tidak pernah diganggu.
 */
function prepareCronSecret() {
  const explicit = clean(process.env.CRON_SECRET);
  if (explicit) {
    process.env.WIOM_CRON_SECRET_ORIGIN = "environment";
    return;
  }
  const file = cronSecretFilePath();
  try {
    const persisted = readSecret(file) || createPersistentSecret(file);
    process.env.CRON_SECRET = persisted;
    process.env.WIOM_CRON_SECRET_ORIGIN = "persistent-file";
    console.info(`[WIOM] CRON_SECRET disiapkan otomatis dari penyimpanan server: ${file}`);
  } catch (error) {
    console.warn(
      `[WIOM] CRON_SECRET tidak dapat disiapkan (${error.message}); ` +
      "evaluasi alert terjadwal dinonaktifkan sampai CRON_SECRET diisi manual."
    );
  }
}

prepareCronSecret();

function embeddedSyncEnabled() {
  const value = process.env.WIOM_EMBEDDED_SYNC?.trim().toLowerCase();
  return !["0", "false", "off", "disabled"].includes(value || "");
}

/**
 * Seberapa keras worker Superset dituntut sebelum server web boleh menyala.
 *
 *   "off"      — worker opsional.
 *   "required" — worker dinyalakan dan ditunggu, tetapi kegagalannya TIDAK
 *                mematikan server web.
 *   "strict"   — kegagalan worker membatalkan start-up (perilaku lama).
 *
 * Bawaan image adalah "required". Sebelumnya nilai `1` berarti "strict", dan
 * itu membuat satu worker data — yang sudah punya supervisor dengan retry
 * sendiri — dapat menjatuhkan seluruh aplikasi web pada saat deploy. Satu
 * cookie Superset kedaluwarsa tidak boleh berarti dashboard, halaman
 * Pengaturan, dan alert ikut mati.
 */
function syncRequirement() {
  if (process.argv.includes("--sync-optional")) return "off";
  const value = process.env.WIOM_SYNC_REQUIRED?.trim().toLowerCase() || "";
  if (["strict", "block", "enforce"].includes(value)) return "strict";
  if (["1", "true", "on", "required"].includes(value)) return "required";
  return "off";
}

function embeddedSyncRequired() {
  return syncRequirement() !== "off";
}

function embeddedSyncBlocksStartup() {
  return syncRequirement() === "strict";
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
      ["-c", "import ssl, duckdb, pandas, requests"],
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
  const runtimeDir = path.resolve(
    clean(process.env.WIOM_RUNTIME_CONFIG_DIR) ||
    path.join(path.dirname(process.env.DUCKDB_STATE_PATH), "runtime-config")
  );
  const runtimeConfig = path.join(runtimeDir, path.basename(configFile));
  const effectiveConfig = fs.existsSync(runtimeConfig) ? runtimeConfig : configFile;
  try {
    // Worker Python mengutamakan runtime-config. Supervisor harus membaca file
    // efektif yang sama; bila tidak, path heartbeat kustom hasil simpan Settings
    // akan terlihat offline setelah redeploy walau worker sebenarnya sehat.
    const config = JSON.parse(fs.readFileSync(effectiveConfig, "utf8"));
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
  // Hanya mode "strict" yang boleh membatalkan start-up. Pada mode "required"
  // kegagalan dicatat keras lalu server web tetap menyala, karena aplikasi yang
  // hidup dengan data usang jauh lebih berguna — dan jauh lebih dapat
  // diperbaiki lewat halaman Pengaturan — daripada container yang menolak
  // menyala dan digulung balik orkestrator.
  const blocks = embeddedSyncBlocksStartup();
  if (!embeddedSyncEnabled()) {
    const message = "WIOM_SYNC_REQUIRED aktif tetapi WIOM_EMBEDDED_SYNC dinonaktifkan.";
    if (embeddedSyncRequired()) {
      if (blocks) throw new Error(message);
      console.warn(`[WIOM] ${message} Worker Superset dianggap dijalankan terpisah.`);
      return undefined;
    }
    console.info("[WIOM] Worker Superset terpisah dipilih; embedded sync dinonaktifkan.");
    return undefined;
  }

  const script = path.join(process.cwd(), "scripts", "superset_to_duckdb.py");
  if (!fs.existsSync(script)) {
    const message = "Worker Superset tidak dimulai: script sinkronisasi tidak tersedia.";
    if (blocks) throw new Error(message);
    console.warn(`[WIOM] ${message}`);
    return undefined;
  }
  const python = findPython();
  if (!python) {
    const message =
      "Worker Superset tidak dimulai: Python 3 atau dependency " +
      "duckdb/pandas/requests tidak tersedia.";
    if (blocks) throw new Error(message);
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
    if (blocks) throw new Error(message);
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

function acquireWebInstanceLock(port) {
  const stateDb = path.resolve(
    clean(process.env.DUCKDB_STATE_PATH) || "./db/app_state.duckdb"
  );
  const lockFile = `${stateDb}.web.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const record = {
        pid: process.pid,
        web_pid: null,
        port,
        started_at: new Date().toISOString(),
      };
      fs.writeFileSync(
        lockFile,
        `${JSON.stringify(record)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      let released = false;
      return {
        file: lockFile,
        setWebPid(webPid) {
          record.web_pid = Number(webPid) || null;
          fs.writeFileSync(lockFile, `${JSON.stringify(record)}\n`, "utf8");
        },
        release() {
          if (released) return;
          released = true;
          try {
            const owner = JSON.parse(fs.readFileSync(lockFile, "utf8"));
            if (Number(owner?.pid) === process.pid) fs.rmSync(lockFile, { force: true });
          } catch {
            // A missing or replaced marker is already safe to leave alone.
          }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      } catch {
        owner = undefined;
      }
      const ownerPid = Number(owner?.pid);
      const webPid = Number(owner?.web_pid);
      const activePid = pidAlive(webPid) ? webPid : pidAlive(ownerPid) ? ownerPid : null;
      if (activePid) {
        throw new Error(
          `Instance WIOM lain (PID ${activePid}, port ${owner?.port || "?"}) ` +
          `sudah memakai ${stateDb}. Hentikan instance tersebut atau gunakan ` +
          "DUCKDB_STATE_PATH yang berbeda untuk preview."
        );
      }
      fs.rmSync(lockFile, { force: true });
    }
  }
  throw new Error(`Lock instance WIOM tidak dapat dibuat: ${lockFile}`);
}

function startScheduler(port) {
  // Opt-out eksplisit untuk deployment yang memakai cron eksternal
  // (deploy/crontab.example) dan tidak ingin dua penjadwal berjalan bersamaan.
  const schedulerFlag = process.env.WIOM_SCHEDULER?.trim().toLowerCase();
  if (["0", "false", "off", "disabled"].includes(schedulerFlag || "")) {
    console.info("[WIOM] Scheduler bawaan dinonaktifkan (WIOM_SCHEDULER=0).");
    return undefined;
  }
  const secret = clean(process.env.CRON_SECRET);
  if (!secret) {
    console.warn("[WIOM] CRON_SECRET belum diisi; evaluasi alert terjadwal dinonaktifkan.");
    return undefined;
  }
  const base = `http://127.0.0.1:${port}`;
  const tickMs = Math.max(300_000, Number(process.env.TICK_INTERVAL_MS || 600_000));
  let sentDaily = "";
  let stopping = false;
  const timers = [];

  // Gerbangnya adalah liveness, bukan /api/health.
  //
  // /api/health ikut menuntut snapshot yang segar (≤ 30 menit). Menjadikannya
  // syarat tick berarti evaluasi alert berhenti tepat ketika sinkronisasi
  // bermasalah — saat gudang justru paling tidak terpantau. Kesegaran data
  // tetap dilaporkan endpoint itu; ia bukan izin untuk menjalankan tick.
  async function healthy() {
    try {
      const response = await fetch(`${base}/api/live`, {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function call(route) {
    if (stopping || !(await healthy())) return false;
    try {
      const response = await fetch(`${base}${route}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
      }
      console.info(`[WIOM] ${route} OK`);
      return true;
    } catch (error) {
      console.error(`[WIOM] ${route} gagal: ${error.message}`);
      return false;
    }
  }

  function jakartaNow() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date()).reduce(
      (out, part) => ({ ...out, [part.type]: part.value }),
      {},
    );
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      hour: Number(parts.hour),
      minute: Number(parts.minute),
    };
  }

  async function dailyIfDue() {
    const now = jakartaNow();
    if (now.hour === 8 && now.minute < 5 && sentDaily !== now.date) {
      if (await call("/api/cron/daily-summary")) sentDaily = now.date;
    }
  }

  const initial = setTimeout(() => { void call("/api/cron/tick"); }, 30_000);
  const tick = setInterval(() => { void call("/api/cron/tick"); }, tickMs);
  const daily = setInterval(() => { void dailyIfDue(); }, 60_000);
  initial.unref?.();
  tick.unref?.();
  daily.unref?.();
  timers.push(initial, tick, daily);
  void dailyIfDue();
  console.info(`[WIOM] Scheduler ringan aktif setiap ${Math.round(tickMs / 60_000)} menit.`);
  return {
    stop() {
      stopping = true;
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

/**
 * Cetak diagnosis kesiapan ke log deployment, sekali, setelah server menyala.
 *
 * Ini menutup lubang yang membuat kegagalan deploy 2026-08-20 mahal: Docker
 * hanya mencatat `ExitCode 1` dengan `Output: ""`, sehingga tidak ada satu pun
 * petunjuk kenapa container dianggap tidak sehat. Kondisi sebenarnya sudah
 * lama dihitung /api/ready; yang kurang hanyalah menaruhnya di tempat yang
 * dibaca operator, yaitu `docker logs` dan panel deployment Coolify.
 *
 * Satu sumber kebenaran: laporan ini murni membaca /api/ready, tidak
 * menghitung ulang apa pun.
 */
function announceRuntimeState(port) {
  const base = `http://127.0.0.1:${port}`;
  void (async () => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      let body;
      try {
        const response = await fetch(`${base}/api/ready`, {
          cache: "no-store",
          signal: AbortSignal.timeout(8_000),
        });
        body = await response.json();
      } catch {
        await delay(2_000);
        continue;
      }
      const checks = body?.checks || {};
      const storage = checks.config_storage || {};
      if (body?.status === "ready") {
        console.info(
          "[WIOM] Kesiapan: READY — konfigurasi tersimpan permanen " +
          `(${storage.persisted ?? 0} berkas di volume).`
        );
        return;
      }
      console.warn("[WIOM] Kesiapan: BELUM SIAP. Server web tetap melayani trafik.");
      if (storage.status === "error") {
        console.warn(
          `[WIOM]   Penyimpanan konfigurasi: ${storage.code || "TIDAK_DURABLE"}. ` +
          `${storage.fix || ""}`
        );
        console.warn(
          "[WIOM]   Selama ini belum diperbaiki, setiap penyetelan di halaman " +
          "Pengaturan akan hilang saat container diganti (deploy ulang)."
        );
      }
      const accounts = checks.accounts || {};
      if (accounts.status === "error") {
        console.warn(
          `[WIOM]   Akun: belum ada admin aktif${accounts.error ? ` (${accounts.error})` : ""}.`
        );
      }
      const worker = checks.superset_worker || {};
      if (worker.required && !worker.ready) {
        console.warn(
          `[WIOM]   Worker Superset: belum siap${worker.error ? ` — ${worker.error}` : ""}.`
        );
      }
      return;
    }
    console.warn("[WIOM] Kesiapan tidak dapat dibaca dalam 2 menit; periksa /api/ready manual.");
  })();
}

const port = commandLineValue("--port") || process.env.PORT?.trim() || "3000";
if (!/^\d{2,5}$/.test(port) || Number(port) > 65_535) {
  throw new Error(`Port tidak valid: ${port}`);
}
const webInstanceLock = acquireWebInstanceLock(port);
process.on("exit", () => webInstanceLock.release());

let syncSupervisor;
try {
  syncSupervisor = startSyncSupervisor();
} catch (error) {
  webInstanceLock.release();
  throw error;
}

if (syncSupervisor && embeddedSyncRequired()) {
  try {
    await syncSupervisor.waitUntilReady();
    console.info("[WIOM] Worker Superset siap; web server dapat menerima trafik.");
  } catch (error) {
    if (embeddedSyncBlocksStartup()) {
      syncSupervisor.stop();
      webInstanceLock.release();
      throw error;
    }
    // Worker punya supervisor dengan backoff sendiri dan akan terus mencoba.
    // Menahan server web di sini hanya menambah satu kegagalan deploy pada
    // masalah yang sudah punya jalur pemulihannya sendiri.
    console.warn(
      `[WIOM] ${error.message} Server web tetap dinyalakan; worker terus dicoba ulang ` +
      "dan statusnya dilaporkan di /api/ready serta halaman Pengaturan."
    );
  }
}

const standaloneServer = path.join(process.cwd(), "server.js");
const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const useStandalone = fs.existsSync(standaloneServer);
if (!useStandalone && !fs.existsSync(nextBin)) {
  syncSupervisor?.stop();
  throw new Error("Runtime Next.js tidak ditemukan.");
}

const child = spawn(
  process.execPath,
  useStandalone ? [standaloneServer] : [nextBin, "start", "-p", port],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: port,
      // Docker sets HOSTNAME to the container id (e.g. e44a32a0215a). Passing
      // that to Next.js makes it bind only to the container's specific IP, so
      // healthchecks via 127.0.0.1 fail. Always bind to all interfaces unless
      // an explicit bind address is provided.
      HOSTNAME: clean(process.env.WIOM_BIND_ADDRESS) || "0.0.0.0",
    },
    stdio: "inherit",
  }
);
webInstanceLock.setWebPid(child.pid);
const scheduler = startScheduler(port);
announceRuntimeState(port);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    scheduler?.stop();
    syncSupervisor?.stop(signal);
    child.kill(signal);
  });
}

child.on("error", (error) => {
  scheduler?.stop();
  syncSupervisor?.stop();
  webInstanceLock.release();
  console.error(`[WIOM] Gagal menjalankan Next.js: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  scheduler?.stop();
  syncSupervisor?.stop(signal || "SIGTERM");
  webInstanceLock.release();
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
