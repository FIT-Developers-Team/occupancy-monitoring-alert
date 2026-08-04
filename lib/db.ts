// ---------------------------------------------------------------------------
// DuckDB data layer.
//   HISTORY DB  : written by scripts/superset_to_duckdb.py (or seed). The web
//                 app queries a short-lived process-local replica so Windows
//                 never leaves the sync source file locked by Node.
//   STATE DB    : owned exclusively by this app (alerts, audit, notifications,
//                 rule/hysteresis state). Singleton writer connection.
// ---------------------------------------------------------------------------
import duckdb from "duckdb";
import path from "path";
import fs from "fs";
import os from "os";

const HISTORY_PATH =
  process.env.DUCKDB_HISTORY_PATH || path.join(process.cwd(), "db", "warehouse_history.duckdb");
const STATE_PATH =
  process.env.DUCKDB_STATE_PATH || path.join(process.cwd(), "db", "app_state.duckdb");
const HISTORY_WRITE_INTENT_PATH = `${HISTORY_PATH}.write-intent`;
// The dashboard reads a process-local snapshot instead of the writer's file.
// This is important on Windows: even a read-only DuckDB handle prevents the
// Superset worker from opening the source database for its next sync.
const HISTORY_REPLICA_DIR = path.join(os.tmpdir(), "fit-occupancy-read", String(process.pid));
const HISTORY_THREADS = Math.max(1, Math.min(8, Number.parseInt(process.env.WIOM_DUCKDB_THREADS || "2", 10) || 2));
// 256 MB made the legacy DuckDB Node binding terminate natively on the 48-hour
// trend aggregation. 320 MB is the lowest verified ceiling with headroom
// inside the 384 MiB web-service limit; normal post-query RSS is ~120 MiB.
const requestedMemory = (process.env.WIOM_DUCKDB_MEMORY_LIMIT || "320MB").toUpperCase();
const HISTORY_MEMORY = /^\d+(?:MB|GB)$/.test(requestedMemory) ? requestedMemory : "320MB";
const HISTORY_TEMP = path.join(os.tmpdir(), `wiom-duckdb-${process.pid}`).replaceAll("'", "''");

// ---- normalizer: BigInt -> number, Date -> ISO string (verified behaviour) --
function norm(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = norm(val);
    return o;
  }
  return v;
}

function allAsync(db: duckdb.Database, sql: string, params: unknown[]): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    (db as any).all(sql, ...params, (err: Error | null, rows: unknown[]) =>
      err ? reject(err) : resolve(rows)
    );
  });
}

/**
 * DuckDB opens files asynchronously. Querying a freshly constructed Database
 * can race the native connection on newer Node runtimes, especially when the
 * file does not exist yet. Always wait for the constructor callback.
 */
function openAsync(file: string, accessMode?: number): Promise<duckdb.Database> {
  return new Promise((resolve, reject) => {
    let db: duckdb.Database;
    const onOpen = (error: Error | null) => (error ? reject(error) : resolve(db));
    db =
      accessMode === undefined
        ? new duckdb.Database(file, onOpen)
        : new duckdb.Database(file, accessMode, onOpen);
  });
}

function execAsync(db: duckdb.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (error: Error | null) => (error ? reject(error) : resolve()));
  });
}

function closeAsync(db: duckdb.Database): Promise<void> {
  return new Promise((resolve) => db.close(() => resolve()));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isRetryableHistoryError = (error: unknown) =>
  /(lock|locked|busy|conflict|another process|cannot open file)/i.test(
    error instanceof Error ? error.message : String(error),
  );

export function historyDbExists(): boolean {
  return fs.existsSync(HISTORY_PATH);
}

function historyWriterPending(): boolean {
  try {
    const age = Date.now() - fs.statSync(HISTORY_WRITE_INTENT_PATH).mtimeMs;
    // A crashed writer must not block the dashboard forever. The next worker
    // pass replaces this marker; five minutes is well above the measured local
    // write window while still self-healing without manual file deletion.
    return age >= 0 && age < 300_000;
  } catch {
    return false;
  }
}

async function waitForHistoryWriter(): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (historyWriterPending() && Date.now() < deadline) await sleep(150);
  if (historyWriterPending()) {
    throw new Error("Sinkronisasi sedang memperbarui database. Coba lagi setelah proses tulis selesai.");
  }
}

// ---- history DB: shared, short-lived replica reader ------------------------
// Opening DuckDB per query cost a measured ~18 ms against ~4 ms on a reused
// handle, and one dashboard render issues several queries. The replica handle
// is therefore shared and reference-counted, then dropped as soon as it falls
// idle. This keeps query overhead low without ever holding the source DB.
interface SharedReader {
  db: duckdb.Database;
  file: string;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  expiresAt: number;
}

const IDLE_CLOSE_MS = 50;
const MAX_LIFETIME_MS = 1_500;

let reader: SharedReader | null = null;
let opening: Promise<SharedReader> | null = null;
let replicaOpening: Promise<string> | null = null;
let replicaVersion = "";
let replicaPath = "";

function historyVersionFromStat(stat: fs.Stats): string {
  return `${stat.size}-${Math.trunc(stat.mtimeMs)}`;
}

export function historyDbVersion(): string {
  try { return historyVersionFromStat(fs.statSync(HISTORY_PATH)); } catch { return "missing"; }
}

async function ensureHistoryReplica(): Promise<string> {
  const source = fs.statSync(HISTORY_PATH);
  const version = historyVersionFromStat(source);
  if (replicaVersion === version && replicaPath && fs.existsSync(replicaPath)) return replicaPath;
  if (replicaOpening) return replicaOpening;

  replicaOpening = (async () => {
    await fs.promises.mkdir(HISTORY_REPLICA_DIR, { recursive: true });
    // The worker raises write-intent before opening DuckDB. If that marker
    // appears while copying, discard the partial snapshot and retry after the
    // writer closes so readers never observe a torn database file.
    for (let attempt = 0; attempt < 4; attempt++) {
      await waitForHistoryWriter();
      const before = await fs.promises.stat(HISTORY_PATH);
      const nextVersion = historyVersionFromStat(before);
      const target = path.join(HISTORY_REPLICA_DIR, `history-${nextVersion}.duckdb`);
      if (!fs.existsSync(target)) {
        const staging = `${target}.${Date.now()}.tmp`;
        try {
          await fs.promises.copyFile(HISTORY_PATH, staging);
          const after = await fs.promises.stat(HISTORY_PATH);
          if (historyWriterPending() || historyVersionFromStat(after) !== nextVersion) {
            await fs.promises.unlink(staging).catch(() => undefined);
            continue;
          }
          await fs.promises.rename(staging, target).catch(async (error: NodeJS.ErrnoException) => {
            await fs.promises.unlink(staging).catch(() => undefined);
            if (error.code !== "EEXIST") throw error;
          });
        } catch (error) {
          await fs.promises.unlink(staging).catch(() => undefined);
          throw error;
        }
      }
      replicaVersion = nextVersion;
      replicaPath = target;
      return target;
    }
    throw new Error("Database sedang disinkronkan; snapshot baca belum stabil.");
  })().finally(() => {
    replicaOpening = null;
  });
  return replicaOpening;
}

function disposeReader(target: SharedReader): void {
  if (reader === target) reader = null;
  if (target.idleTimer) {
    clearTimeout(target.idleTimer);
    target.idleTimer = null;
  }
  void closeAsync(target.db).then(() => {
    if (target.file !== replicaPath) void fs.promises.unlink(target.file).catch(() => undefined);
  });
}

async function acquireReader(): Promise<SharedReader> {
  const file = await ensureHistoryReplica();
  if (reader && reader.file === file && Date.now() < reader.expiresAt) {
    if (reader.idleTimer) {
      clearTimeout(reader.idleTimer);
      reader.idleTimer = null;
    }
    reader.refs += 1;
    return reader;
  }
  // An expired handle with queries still in flight is left for its own release
  // to close; only an idle one can be torn down here.
  if (reader && reader.refs === 0) disposeReader(reader);
  if (!opening) {
    opening = openAsync(file, duckdb.OPEN_READONLY)
      .then(async (db) => {
        try {
          await execAsync(
            db,
            `SET threads = ${HISTORY_THREADS}; SET memory_limit = '${HISTORY_MEMORY}'; ` +
              `SET preserve_insertion_order = false; SET temp_directory = '${HISTORY_TEMP}';`,
          );
        } catch (error) {
          await closeAsync(db);
          throw error;
        }
        reader = { db, file, refs: 0, idleTimer: null, expiresAt: Date.now() + MAX_LIFETIME_MS };
        opening = null;
        return reader;
      })
      .catch((error) => {
        opening = null;
        throw error;
      });
  }
  const active = await opening;
  active.refs += 1;
  return active;
}

function releaseReader(target: SharedReader, failed: boolean): void {
  target.refs -= 1;
  if (target.refs > 0) return;
  // A failed query may mean the file was replaced mid-read; never reuse it.
  if (failed || Date.now() >= target.expiresAt) {
    disposeReader(target);
    return;
  }
  target.idleTimer = setTimeout(() => {
    if (target.refs === 0) disposeReader(target);
  }, IDLE_CLOSE_MS);
  target.idleTimer.unref?.();
}

/**
 * DuckDB's Node binding can terminate the process when several native `all`
 * calls share one Database handle concurrently. A single queue is also kinder
 * to a small VPS: analytical scans reuse one short-lived reader and two threads
 * instead of competing for memory.
 */
let historyQueryQueue: Promise<void> = Promise.resolve();

async function runHistoryQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  if (!historyDbExists()) {
    throw new Error(
      `Database history tidak ditemukan di ${HISTORY_PATH}. Jalankan "npm run seed" (demo) atau sync Superset terlebih dahulu.`
    );
  }
  let lastErr: unknown;
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let active: SharedReader | null = null;
    let failed = false;
    try {
      await waitForHistoryWriter();
      active = await acquireReader();
      const rows = await allAsync(active.db, sql, params);
      return rows.map(norm) as T[];
    } catch (e) {
      lastErr = e;
      failed = true;
      if (!(attempt < maxAttempts && isRetryableHistoryError(e))) throw e;
    } finally {
      if (active) releaseReader(active, failed);
    }
    await sleep(200 * Math.min(attempt, 4));
  }
  throw lastErr;
}

/** Read-only query, serialized and retried through sync-writer lock windows. */
export function queryHistory<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = historyQueryQueue.then(() => runHistoryQuery<T>(sql, params));
  historyQueryQueue = result.then(() => undefined, () => undefined);
  return result;
}

// Best-effort cleanup. The replica is disposable and never contains the state
// database, configuration, or secrets.
process.once("exit", () => {
  try { fs.rmSync(HISTORY_REPLICA_DIR, { recursive: true, force: true }); } catch {}
});

// ---- state DB: singleton writer, schema self-initialising ------------------
const STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS alerts (
  alert_id VARCHAR PRIMARY KEY,
  created_at TIMESTAMP, updated_at TIMESTAMP,
  rule_id VARCHAR, rule_name VARCHAR, severity VARCHAR,
  warehouse_code VARCHAR, zone VARCHAR, sloc_code VARCHAR, sku VARCHAR,
  title VARCHAR, detail VARCHAR,
  status VARCHAR, dedup_key VARCHAR, occurrences INTEGER DEFAULT 1,
  acknowledged_by VARCHAR, acknowledged_at TIMESTAMP,
  resolved_by VARCHAR, resolved_at TIMESTAMP, resolution_note VARCHAR,
  escalation_level INTEGER DEFAULT 1, next_escalation_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS alert_events (
  id VARCHAR PRIMARY KEY, alert_id VARCHAR, "at" TIMESTAMP,
  actor VARCHAR, action VARCHAR, note VARCHAR
);
CREATE TABLE IF NOT EXISTS audit_log (
  id VARCHAR PRIMARY KEY, "at" TIMESTAMP, actor VARCHAR, action VARCHAR,
  entity VARCHAR, before_json VARCHAR, after_json VARCHAR
);
CREATE TABLE IF NOT EXISTS notification_log (
  id VARCHAR PRIMARY KEY, alert_id VARCHAR, channel VARCHAR, recipient VARCHAR,
  "at" TIMESTAMP, status VARCHAR, message VARCHAR
);
CREATE TABLE IF NOT EXISTS rule_state (
  key VARCHAR PRIMARY KEY, state VARCHAR, value VARCHAR, updated_at TIMESTAMP
);
`;

type G = typeof globalThis & {
  __wiomStateOpen?: Promise<duckdb.Database>;
  __wiomStateInit?: Promise<void>;
};
const g = globalThis as G;

async function getStateDb(): Promise<duckdb.Database> {
  if (!g.__wiomStateOpen) {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    g.__wiomStateOpen = openAsync(STATE_PATH).catch((error) => {
      g.__wiomStateOpen = undefined;
      throw error;
    });
  }
  const db = await g.__wiomStateOpen;
  if (!g.__wiomStateInit) {
    g.__wiomStateInit = execAsync(db, STATE_SCHEMA).catch((error) => {
      g.__wiomStateInit = undefined;
      throw error;
    });
  }
  await g.__wiomStateInit;
  return db;
}

export async function stateQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const db = await getStateDb();
  const rows = await allAsync(db, sql, params);
  return rows.map(norm) as T[];
}

export async function stateExec(sql: string, params: unknown[] = []): Promise<void> {
  const db = await getStateDb();
  await allAsync(db, sql, params);
}

export function uid(prefix = ""): string {
  return (
    prefix +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 8)
  );
}
