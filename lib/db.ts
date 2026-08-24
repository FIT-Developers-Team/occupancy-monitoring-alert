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
import { createHash } from "crypto";

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
  // A sync write window is transient by construction, so it is retryable no
  // matter what its wording is. Checked by type first: relying on the message
  // alone is what let this failure reach the page as a dead end.
  error instanceof HistoryWriterBusyError
  || /(lock|locked|busy|conflict|another process|cannot open file)/i.test(
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

/**
 * Raised while the sync worker holds its write window.
 *
 * Marked as its own type because it is always transient — the worker releases
 * the marker within seconds. It used to surface as a plain Error whose text
 * matched none of the retry patterns, so a page opened during a sync went
 * straight to the error boundary and the operator saw "Coba lagi" on a
 * dashboard whose data was perfectly readable a moment earlier.
 */
class HistoryWriterBusyError extends Error {
  constructor() {
    super("Sinkronisasi sedang memperbarui database. Coba lagi setelah proses tulis selesai.");
    this.name = "HistoryWriterBusyError";
  }
}

/**
 * Wait for the sync worker's write window to close.
 *
 * The wait is deliberately short: callers either fall back to the snapshot
 * already on disk or retry, both of which serve the operator better than
 * blocking a page render for the better part of a minute.
 */
async function waitForHistoryWriter(timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (historyWriterPending() && Date.now() < deadline) await sleep(120);
  if (historyWriterPending()) throw new HistoryWriterBusyError();
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

/**
 * Opaque marker for the snapshot the dashboard is currently reading.
 *
 * Same input as historyDbVersion — the file's size and mtime, which is exactly
 * what the read model invalidates on — but hashed, because this one is sent to
 * the browser. The client only ever needs to answer "did the snapshot change?",
 * never the size or write time of a file on the server.
 */
export function historyDataVersion(): string {
  const version = historyDbVersion();
  return version === "missing"
    ? "missing"
    : createHash("sha1").update(version).digest("hex").slice(0, 12);
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
      try {
        await waitForHistoryWriter();
      } catch (error) {
        // A sync is mid-write. The replica already on disk is a complete,
        // internally consistent snapshot from the previous pass, so serve that
        // rather than failing the page: one cycle of staleness is a far better
        // answer than an error boundary, and the next request picks up the new
        // version as soon as the writer releases.
        if (error instanceof HistoryWriterBusyError && replicaPath && fs.existsSync(replicaPath)) {
          return replicaPath;
        }
        throw error;
      }
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
          // Prepare the snapshot while it is still staging, so a file named
          // `history-<version>.duckdb` is only ever a fully ready replica.
          await materialiseReplicaViews(staging);
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
      void pruneSupersededReplicas(target);
      return target;
    }
    // Four attempts and the file kept moving underneath us. Same reasoning as
    // the busy-writer path: an older complete snapshot beats no dashboard.
    if (replicaPath && fs.existsSync(replicaPath)) return replicaPath;
    throw new HistoryWriterBusyError();
  })().finally(() => {
    replicaOpening = null;
  });
  return replicaOpening;
}

/**
 * Turn the three dashboard views into real tables inside the private replica.
 *
 * `vw_sloc` deduplicates 358k planogram rows with a window function and
 * `vw_stock_latest` re-scans 1.7M history rows for the newest snapshot — on
 * every query. Measured against this database, paying that once per snapshot
 * instead cuts the warehouse scope query by 70% and the trend and zone queries
 * by about a fifth, for ~1.4s of one-off work per sync.
 *
 * KENAPA `vw_movement` IKUT, MESKI PALING MAHAL
 * ---------------------------------------------
 * `vw_movement` menghitung md5 atas tiga belas kolom untuk SETIAP baris
 * `movement_events`, lalu men-dedup hasilnya dengan fungsi window — dan itu
 * dibayar ulang pada setiap kueri. Halaman Pergerakan menembakkan EMPAT kueri
 * untuk satu tampilan (baris, ringkasan, aktivitas, per gudang), dan antrean di
 * bawah menjalankannya berurutan, jadi biayanya berlipat empat pada setiap
 * klik: ganti halaman, ganti urutan, ubah filter. Terukur pada basis data ini —
 * 356 ribu baris movement — satu tarikan penuh memakan 6–10 detik.
 *
 * Setelah dijadikan tabel, kueri yang sama turun ke bawah 0,05 detik. Harganya
 * ~7 detik kerja sekali per snapshot dan ~50 MB pada salinan sementara. Itu
 * pertukaran yang jelas menguntungkan: snapshot berganti paling cepat sepuluh
 * menit sekali, sedangkan klik pada halaman Pergerakan terjadi terus-menerus.
 *
 * The replica is a disposable process-local copy, so writing to it cannot
 * affect the source database or the sync worker. Failure is non-fatal: the
 * original views are still there and queries simply run at the old speed.
 */
async function materialiseReplicaViews(file: string): Promise<void> {
  let db: duckdb.Database | null = null;
  try {
    db = await openAsync(file);
    await execAsync(
      db,
      `SET threads = ${HISTORY_THREADS}; SET memory_limit = '${HISTORY_MEMORY}';
       SET preserve_insertion_order = false; SET temp_directory = '${HISTORY_TEMP}';
       CREATE OR REPLACE TABLE _sloc_current AS SELECT * FROM vw_sloc;
       CREATE OR REPLACE VIEW vw_sloc AS SELECT * FROM _sloc_current;
       CREATE OR REPLACE TABLE _stock_current AS SELECT * FROM vw_stock_latest;
       CREATE OR REPLACE VIEW vw_stock_latest AS SELECT * FROM _stock_current;
       CHECKPOINT;`,
    );
    // Dijalankan terpisah supaya kegagalannya — misalnya pada instalasi baru
    // yang belum pernah menyinkronkan movement sama sekali, sehingga
    // `movement_events` belum ada — tidak ikut membatalkan materialisasi dua
    // view di atas yang sudah berhasil.
    await execAsync(
      db,
      `CREATE OR REPLACE TABLE _movement_current AS SELECT * FROM vw_movement;
       CREATE OR REPLACE VIEW vw_movement AS SELECT * FROM _movement_current;
       CHECKPOINT;`,
    );
  } catch (error) {
    console.warn(
      `[WIOM] Materialisasi replika dilewati (${(error as Error).message.slice(0, 160)}) — dashboard tetap jalan dengan view asli.`,
    );
  } finally {
    if (db) await closeAsync(db);
  }
}

/**
 * Delete replicas of older snapshots left in this process's directory.
 *
 * disposeReader only unlinks a file that is no longer the current replica, so
 * the previous snapshot survived every sync and the directory grew by another
 * full copy of the database each time.
 */
async function pruneSupersededReplicas(keep: string): Promise<void> {
  try {
    const entries = await fs.promises.readdir(HISTORY_REPLICA_DIR);
    await Promise.all(entries.map(async (entry) => {
      const full = path.join(HISTORY_REPLICA_DIR, entry);
      if (full === keep || (reader && reader.file === full)) return;
      if (!/^history-.*\.duckdb(\.\d+\.tmp)?$/.test(entry)) return;
      await fs.promises.unlink(full).catch(() => undefined);
    }));
  } catch {
    // Best effort: a replica left behind costs disk, never correctness.
  }
}

/**
 * Remove replica directories belonging to processes that no longer exist.
 *
 * The exit hook only runs on a clean shutdown; a crash, a container restart or
 * a dev-server reload leaves a full copy of the database behind. Measured on
 * this machine: seven abandoned directories holding 884 MB.
 */
function sweepAbandonedReplicaDirs(): void {
  const root = path.dirname(HISTORY_REPLICA_DIR);
  let entries: string[];
  try { entries = fs.readdirSync(root); } catch { return; }
  for (const entry of entries) {
    const pid = Number.parseInt(entry, 10);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    let dead = false;
    try {
      // Signal 0 tests for existence without touching the process.
      process.kill(pid, 0);
    } catch (error) {
      dead = (error as NodeJS.ErrnoException).code === "ESRCH";
    }
    if (!dead) continue;
    try {
      fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    } catch (error) {
      // Reclaiming disk space must never be able to stop the app from starting.
      // On Windows the file handle of a killed process can stay held for a
      // moment (and a virus scanner can hold it longer), so `rm` fails with
      // EPERM/EBUSY. Unhandled, that threw during module import and took the
      // whole process down — observed as a deployment failing at page-data
      // collection over a leftover temporary copy. The next pass retries.
      const code = (error as NodeJS.ErrnoException).code;
      console.warn(
        `[WIOM] Salinan baca lama ${entry} belum dapat dihapus (${code ?? "unknown"}); dicoba lagi nanti.`,
      );
    }
  }
}
sweepAbandonedReplicaDirs();

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
      // No writer wait here on purpose. Queries run against a private replica,
      // which shares nothing with the file the sync worker writes — the only
      // step that touches the source is the copy inside ensureHistoryReplica(),
      // and that coordinates with the writer itself and falls back to the
      // previous snapshot when one is in progress. Waiting here instead meant
      // every page render blocked on the sync and then failed outright, even
      // though a perfectly readable replica was sitting on disk.
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

/**
 * Antrean tunggal untuk state DB — alasannya sama persis dengan antrean riwayat
 * di atas, dan ketiadaannya di sini adalah kelalaian, bukan keputusan.
 *
 * Binding Node DuckDB dapat MENGHENTIKAN PROSES ketika beberapa panggilan
 * native `all` berbagi satu handle Database secara bersamaan. Riwayat sudah
 * dilindungi; state DB tidak, padahal ia justru koneksi tulis tunggal yang
 * dipakai bersama seluruh permintaan.
 *
 * Pola pemanggilannya membuat hal itu bukan sekadar kemungkinan teoretis.
 * Halaman Alert membuka tiga `listAlerts` sekaligus di dalam satu
 * `Promise.all`, dan halaman Ringkasan menambahkan `activeCountsBySeverity` di
 * sampingnya — beberapa kueri native berbarengan pada satu handle, persis
 * bentuk yang diperingatkan catatan di atas. Gejalanya: server merender
 * halamannya sampai selesai, lalu prosesnya hilang tanpa jejak kesalahan.
 *
 * Menyerialkannya tidak mengubah hasil apa pun — setiap pemanggil sudah
 * menunggu Promise-nya masing-masing — dan biayanya hanya urutan, bukan waktu:
 * satu handle DuckDB memang mengeksekusi satu per satu.
 */
let stateQueryQueue: Promise<void> = Promise.resolve();

function runOnState<T>(work: () => Promise<T>): Promise<T> {
  const result = stateQueryQueue.then(work);
  // Kegagalan diserap di sini saja supaya satu kueri yang gagal tidak menutup
  // antrean bagi kueri berikutnya; pemanggilnya tetap menerima penolakan.
  stateQueryQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function stateQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return runOnState(async () => {
    const db = await getStateDb();
    const rows = await allAsync(db, sql, params);
    return rows.map(norm) as T[];
  });
}

export async function stateExec(sql: string, params: unknown[] = []): Promise<void> {
  await runOnState(async () => {
    const db = await getStateDb();
    await allAsync(db, sql, params);
  });
}

export function uid(prefix = ""): string {
  return (
    prefix +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 8)
  );
}
