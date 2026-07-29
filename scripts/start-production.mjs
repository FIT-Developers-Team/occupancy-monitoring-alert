import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
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

const port = process.env.PORT?.trim() || "3000";
const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "start", "-p", port], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`[WIOM] Gagal menjalankan Next.js: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
