// ---------------------------------------------------------------------------
// DuckDB data layer.
//   HISTORY DB  : written by scripts/superset_to_duckdb.py (or seed). The web
//                 app opens it READ-ONLY per query, with retry — this respects
//                 DuckDB's single-writer model while the Python sync runs.
//   STATE DB    : owned exclusively by this app (alerts, audit, notifications,
//                 rule/hysteresis state). Singleton writer connection.
// ---------------------------------------------------------------------------
import duckdb from "duckdb";
import path from "path";
import fs from "fs";

const HISTORY_PATH =
  process.env.DUCKDB_HISTORY_PATH || path.join(process.cwd(), "db", "warehouse_history.duckdb");
const STATE_PATH =
  process.env.DUCKDB_STATE_PATH || path.join(process.cwd(), "db", "app_state.duckdb");

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

/** Read-only query against the history DB, retrying through sync-writer lock windows. */
export async function queryHistory<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  if (!historyDbExists()) {
    throw new Error(
      `Database history tidak ditemukan di ${HISTORY_PATH}. Jalankan "npm run seed" (demo) atau sync Superset terlebih dahulu.`
    );
  }
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let db: duckdb.Database | null = null;
    let shouldRetry = false;
    try {
      db = await openAsync(HISTORY_PATH, duckdb.OPEN_READONLY);
      const rows = await allAsync(db, sql, params);
      return rows.map(norm) as T[];
    } catch (e) {
      lastErr = e;
      shouldRetry = attempt < 4 && isRetryableHistoryError(e);
      if (!shouldRetry) throw e;
    } finally {
      if (db) await closeAsync(db);
    }
    if (shouldRetry) await sleep(250 * attempt);
  }
  throw lastErr;
}

/**
 * Runs related read queries through one read-only connection. Dashboard reads
 * often need several compact aggregates from the same snapshot; opening and
 * closing DuckDB for every aggregate added avoidable latency.
 */
export async function queryHistoryBatch(
  queries: Array<{ sql: string; params?: unknown[] }>,
): Promise<unknown[][]> {
  if (!historyDbExists()) {
    throw new Error(
      `Database history tidak ditemukan di ${HISTORY_PATH}. Jalankan "npm run seed" (demo) atau sync Superset terlebih dahulu.`,
    );
  }
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let db: duckdb.Database | null = null;
    let shouldRetry = false;
    try {
      db = await openAsync(HISTORY_PATH, duckdb.OPEN_READONLY);
      const result: unknown[][] = [];
      for (const query of queries) {
        const rows = await allAsync(db, query.sql, query.params ?? []);
        result.push(rows.map(norm));
      }
      return result;
    } catch (error) {
      lastErr = error;
      shouldRetry = attempt < 4 && isRetryableHistoryError(error);
      if (!shouldRetry) throw error;
    } finally {
      if (db) await closeAsync(db);
    }
    if (shouldRetry) await sleep(250 * attempt);
  }
  throw lastErr;
}

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
