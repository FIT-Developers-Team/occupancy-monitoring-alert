import crypto from "crypto";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { getWarehouses } from "@/lib/config";

const ROOT = process.cwd();
const CONFIG_DIR = path.join(ROOT, "config");
const DB_DIR = path.join(ROOT, "db");
const CONFIG_FILE = path.join(CONFIG_DIR, "superset-sync.json");
const SECRETS_FILE = path.join(CONFIG_DIR, ".superset-sync.secrets.json");
const STATUS_FILE = path.join(DB_DIR, ".superset-sync-status.json");
const REQUEST_FILE = path.join(DB_DIR, ".superset-sync-request.json");
const HEARTBEAT_FILE = path.join(DB_DIR, ".superset-sync-heartbeat.json");

function isInsideDirectory(directory: string, reference: string): boolean {
  const resolved = path.resolve(ROOT, reference);
  const relative = path.relative(directory, resolved);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

const FilterSchema = z.object({
  col: z.string().trim().min(1),
  op: z.string().trim().min(1),
  val: z.any().optional(),
});

const MetricSchema = z.object({
  agg: z.string().trim().min(1),
  column: z.string().trim().min(1),
  label: z.string().trim().min(1),
});

const DatasetSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().trim()]),
  chart_id: z.union([z.number().int().positive(), z.string().trim(), z.null()]).optional(),
  page: z.enum(["keyset", "offset"]).default("offset"),
  key: z.string().trim().optional(),
  orderby: z.array(z.string().trim().min(1)).optional(),
  columns: z.record(z.string(), z.string().trim().min(1)),
  metrics: z.array(MetricSchema).optional(),
  filters: z.array(FilterSchema).default([]),
  inherit_chart_filters: z.boolean().default(true),
  derive_from_sloc_code: z.boolean().optional(),
  dims_to_cbm_divisor: z.number().positive().optional(),
  segment_by: z.array(z.string().trim().min(1)).optional(),
  server_row_cap: z.number().int().min(1_000).max(10_000_000).optional(),
}).passthrough();

const JobSchema = z.object({
  name: z.string().trim().min(1),
  label: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  required: z.boolean().default(false),
  mode: z.enum(["snapshot", "incremental", "upsert"]),
  target_table: z.string().trim().min(1),
  base_sql: z.string(),
  key_col: z.string().trim().min(1),
  key_type: z.enum(["int", "float", "number", "string", "timestamp"]).default("string"),
  chunk_size: z.number().int().min(500).max(2_000_000).default(50_000),
  watermark_column: z.string().trim().nullable().optional(),
  primary_key: z.array(z.string().trim().min(1)).default([]),
  history_table: z.string().trim().nullable().optional(),
  retention_days: z.number().int().min(1).max(3_650).nullable().optional(),
  // Master/dimension jobs do not need re-pulling every pass. 0 = every pass.
  min_interval_seconds: z.number().int().min(0).max(604_800).default(0),
  // Snapshot jobs append a full copy of current state every pass. Without
  // thinning, a 30-minute interval grows the database by ~390 MB/day. Declared
  // here so a save from Settings does not strip the policy from the config.
  snapshot_retention: z.object({
    keep_all_hours: z.number().int().min(1).max(720).default(30),
    hourly_days: z.number().int().min(0).max(365).default(7),
  }).optional(),
  dataset: DatasetSchema,
}).superRefine((job, ctx) => {
  if (job.enabled && job.required && !String(job.dataset.id).match(/^\d+$/)) {
    ctx.addIssue({
      code: "custom",
      path: ["dataset", "id"],
      message: `Dataset ${job.label} wajib berupa ID angka.`,
    });
  }
  if (job.mode === "upsert" && job.primary_key.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["primary_key"],
      message: "Job upsert membutuhkan primary key.",
    });
  }
});

export const SupersetSyncConfigSchema = z.object({
  version: z.literal(1).default(1),
  duckdb_path: z.string().trim().min(1).default("db/warehouse_history.duckdb"),
  source: z.object({ type: z.literal("superset_dataset").default("superset_dataset") }),
  secret_file: z.string().trim().min(1).default(".superset-sync.secrets.json"),
  superset: z.object({
    base_url: z.string().url().refine((value) => /^https?:\/\//i.test(value), "Gunakan URL HTTP atau HTTPS."),
    timeout_sec: z.number().int().min(5).max(1200).default(120),
    server_row_cap: z.number().int().min(1_000).max(10_000_000).default(5_000_000),
    force_refresh: z.boolean().default(false),
    auth: z.object({
      mode: z.enum(["auto", "login", "cookie", "bearer"]).default("auto"),
      provider: z.enum(["db", "ldap"]).default("db"),
      username: z.string().trim().default(""),
      csrf: z.boolean().default(true),
    }),
  }),
  schedule: z.object({
    enabled: z.boolean().default(true),
    interval_seconds: z.number().int().min(15).max(86_400).default(600),
    retry_count: z.number().int().min(1).max(8).default(3),
  }),
  // These are the only worker controls that materially change resource use.
  // Keep them in the schema so saving Settings cannot silently strip the
  // low-memory VPS guardrails from config/superset-sync.json.
  performance: z.object({
    lookback_minutes: z.number().int().min(0).max(1440).default(10),
    duckdb_threads: z.number().int().min(1).max(8).default(2),
    duckdb_memory_limit: z.string().trim().regex(/^\d+(?:MB|GB)$/i).default("384MB"),
    duckdb_storage_version: z.string().trim().regex(/^v\d+\.\d+\.\d+$/).default("v1.3.0"),
  }).default({}),
  scope: z.object({
    location_ids: z.array(z.number().int().positive()).min(1),
  }),
  control: z.object({
    status_file: z.string().trim().min(1).default("db/.superset-sync-status.json"),
    request_file: z.string().trim().min(1).default("db/.superset-sync-request.json"),
    heartbeat_file: z.string().trim().min(1).default("db/.superset-sync-heartbeat.json"),
    daemon_lock_file: z.string().trim().min(1).default("db/.superset-sync-daemon.lock"),
  }),
  jobs: z.array(JobSchema).min(2),
}).superRefine((config, ctx) => {
  if (!isInsideDirectory(DB_DIR, config.duckdb_path)) {
    ctx.addIssue({
      code: "custom",
      path: ["duckdb_path"],
      message: "Database sinkronisasi harus berada di folder db.",
    });
  }
  for (const [key, value] of Object.entries(config.control)) {
    if (!isInsideDirectory(DB_DIR, value)) {
      ctx.addIssue({
        code: "custom",
        path: ["control", key],
        message: "File runtime sinkronisasi harus berada di folder db.",
      });
    }
  }
  const names = new Set<string>();
  for (const [index, job] of config.jobs.entries()) {
    if (names.has(job.name)) {
      ctx.addIssue({ code: "custom", path: ["jobs", index, "name"], message: "Nama job harus unik." });
    }
    names.add(job.name);
    if (!job.enabled) continue;
    const locationColumn = Object.keys(job.dataset.columns).find((raw) => raw === "location_id");
    if (!locationColumn) {
      ctx.addIssue({
        code: "custom",
        path: ["jobs", index, "dataset", "columns"],
        message: "Job aktif harus memetakan location_id agar scope gudang tetap aman.",
      });
    }
  }
});

const SecretSchema = z.object({
  auth: z.object({
    password: z.string().optional(),
    cookie_header: z.string().optional(),
    access_token: z.string().optional(),
  }).default({}),
});

export const SupersetSyncUpdateSchema = z.object({
  config: SupersetSyncConfigSchema,
  secrets: z.object({
    password: z.string().max(10_000).optional(),
    cookie_header: z.string().max(50_000).optional(),
    access_token: z.string().max(50_000).optional(),
  }).default({}),
  clear_secrets: z.array(z.enum(["password", "cookie_header", "access_token"])).default([]),
});

export type SupersetSyncConfig = z.infer<typeof SupersetSyncConfigSchema>;
export type SupersetSyncJob = z.infer<typeof JobSchema>;
export type SupersetSyncSecretKey = "password" | "cookie_header" | "access_token";

export interface SupersetSyncStatus {
  state: "idle" | "queued" | "running" | "succeeded" | "failed" | "paused" | "not_started";
  service_started_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  next_run_at?: string | null;
  duration_ms?: number | null;
  trigger?: "schedule" | "manual" | null;
  request_id?: string | null;
  requested_by?: string | null;
  rows_pulled?: number;
  rows_written?: number;
  phase?: "extracting" | "waiting_for_database" | "writing" | null;
  current_batch?: number;
  total_batches?: number | null;
  cursor?: string | null;
  throughput_rows_per_sec?: number | null;
  jobs?: Array<{
    name: string;
    status: "OK" | "ERROR" | "SKIPPED" | "UP_TO_DATE";
    rows_pulled: number;
    rows_written: number;
    duration_ms: number;
    message?: string;
    current_batch?: number;
    cursor?: string | null;
    throughput_rows_per_sec?: number | null;
  }>;
  error?: string | null;
  error_category?: string | null;
  error_phase?: string | null;
  error_http_status?: number | null;
  updated_at?: string | null;
  worker: {
    online: boolean;
    ready: boolean;
    heartbeat_at: string | null;
    service_started_at: string | null;
    error: string | null;
  };
}

interface SupersetSyncHeartbeat {
  heartbeat_at?: string | null;
  service_started_at?: string | null;
  ready?: boolean;
  error?: string | null;
}

export class SupersetSyncWorkerUnavailableError extends Error {}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function resolveRuntimePath(reference: string | undefined, fallback: string): string {
  const value = reference?.trim();
  if (!value) return fallback;
  const resolved = path.resolve(ROOT, value);
  if (!isInsideDirectory(DB_DIR, resolved)) {
    throw new Error("File runtime sinkronisasi harus berada di folder db.");
  }
  return resolved;
}

function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  fs.renameSync(temp, file);
  if (mode !== undefined) {
    try { fs.chmodSync(file, mode); } catch { /* Windows and some volumes ignore POSIX modes. */ }
  }
}

export function getSupersetSyncConfig(): SupersetSyncConfig {
  const parsed = SupersetSyncConfigSchema.safeParse(readJson(CONFIG_FILE));
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      || `Konfigurasi Superset tidak ditemukan di ${CONFIG_FILE}.`,
    );
  }
  return parsed.data;
}

function getStoredSecrets(): z.infer<typeof SecretSchema> {
  const parsed = SecretSchema.safeParse(readJson(SECRETS_FILE) ?? {});
  return parsed.success ? parsed.data : { auth: {} };
}

function environmentSecret(key: SupersetSyncSecretKey): string {
  if (key === "password") return process.env.SUPERSET_PASSWORD?.trim() || "";
  if (key === "cookie_header") {
    const full = process.env.SUPERSET_COOKIE_HEADER?.trim();
    const session = process.env.SUPERSET_SESSION_COOKIE?.trim();
    return full || (session ? `session=${session}` : "");
  }
  return process.env.SUPERSET_ACCESS_TOKEN?.trim() || "";
}

function secretValue(key: SupersetSyncSecretKey): string {
  return environmentSecret(key) || getStoredSecrets().auth[key]?.trim() || "";
}

export function getSupersetSyncSettings() {
  const config = getSupersetSyncConfig();
  const stored = getStoredSecrets();
  const keys: SupersetSyncSecretKey[] = ["password", "cookie_header", "access_token"];
  return {
    config,
    secret_state: Object.fromEntries(keys.map((key) => {
      const environment = environmentSecret(key);
      const file = stored.auth[key]?.trim() || "";
      return [
        key,
        {
          configured: Boolean(environment || file),
          source: environment ? "environment" : file ? "file" : null,
        },
      ];
    })),
  };
}

export function writeSupersetSyncSettings(input: unknown) {
  const parsed = SupersetSyncUpdateSchema.parse(input);
  const allowedIds = new Set(getWarehouses().warehouses.map((warehouse) => warehouse.location_id));
  const invalidIds = parsed.config.scope.location_ids.filter((id) => !allowedIds.has(id));
  if (invalidIds.length) {
    throw new Error(`location_id di luar allowlist gudang: ${invalidIds.join(", ")}.`);
  }

  const scopeFilter = {
    col: "location_id",
    op: "IN",
    val: parsed.config.scope.location_ids,
  };
  const config: SupersetSyncConfig = {
    ...parsed.config,
    jobs: parsed.config.jobs.map((job) => ({
      ...job,
      dataset: {
        ...job.dataset,
        filters: [
          scopeFilter,
          ...job.dataset.filters.filter((filter) => filter.col !== "location_id"),
        ],
      },
    })),
  };
  const validated = SupersetSyncConfigSchema.parse(config);

  const stored = getStoredSecrets();
  for (const key of parsed.clear_secrets) delete stored.auth[key];
  for (const [key, value] of Object.entries(parsed.secrets) as Array<[SupersetSyncSecretKey, string | undefined]>) {
    if (value?.trim()) stored.auth[key] = value.trim();
  }

  writeJsonAtomic(CONFIG_FILE, validated);
  writeJsonAtomic(SECRETS_FILE, stored, 0o600);
  return getSupersetSyncSettings();
}

export function getSupersetSyncStatus(): SupersetSyncStatus {
  const config = getSupersetSyncConfig();
  const statusFile = resolveRuntimePath(config.control.status_file, STATUS_FILE);
  const requestFile = resolveRuntimePath(config.control.request_file, REQUEST_FILE);
  const heartbeatFile = resolveRuntimePath(config.control.heartbeat_file, HEARTBEAT_FILE);
  const status = readJson<SupersetSyncStatus>(statusFile);
  const request = readJson<{ request_id?: string; requested_at?: string; requested_by?: string }>(requestFile);
  const heartbeat = readJson<SupersetSyncHeartbeat>(heartbeatFile);
  const heartbeatTime = heartbeat?.heartbeat_at ? Date.parse(heartbeat.heartbeat_at) : Number.NaN;
  const online = Number.isFinite(heartbeatTime) && Date.now() - heartbeatTime < 20_000;
  const worker = {
    online,
    ready: online && heartbeat?.ready === true,
    heartbeat_at: heartbeat?.heartbeat_at ?? null,
    service_started_at: heartbeat?.service_started_at ?? null,
    error: heartbeat?.error ?? null,
  };
  if (!config.schedule.enabled) {
    return { ...(status ?? {}), state: "paused", next_run_at: null, worker };
  }
  if (request && status?.request_id !== request.request_id && status?.state !== "running") {
    return {
      ...(status ?? {}),
      state: "queued",
      request_id: request.request_id ?? null,
      requested_by: request.requested_by ?? null,
      updated_at: request.requested_at ?? null,
      worker,
    };
  }
  return status
    ? { ...status, worker }
    : { state: "not_started", next_run_at: null, updated_at: null, worker };
}

export function requestSupersetSync(actor: string) {
  const config = getSupersetSyncConfig();
  if (!config.schedule.enabled) throw new Error("Jadwal sinkronisasi sedang dijeda.");
  const status = getSupersetSyncStatus();
  const worker = status.worker;
  if (!worker.online || !worker.ready) {
    throw new SupersetSyncWorkerUnavailableError(
      worker.error
        ? `Worker sinkronisasi belum siap: ${worker.error}`
        : "Worker sinkronisasi tidak aktif. Jalankan ulang service web/sync setelah deployment.",
    );
  }
  const requestFile = resolveRuntimePath(config.control.request_file, REQUEST_FILE);
  const existing = readJson<{
    request_id?: string;
    requested_at?: string;
    requested_by?: string;
  }>(requestFile);
  if (existing?.request_id) {
    return {
      request_id: existing.request_id,
      requested_at: existing.requested_at ?? null,
      requested_by: existing.requested_by ?? null,
      reused: true,
    };
  }
  const request = {
    request_id: crypto.randomUUID(),
    requested_at: new Date().toISOString(),
    requested_by: actor,
    reused: false,
  };
  writeJsonAtomic(requestFile, request, 0o600);
  return request;
}

export function assertSupersetSyncCredentials(): void {
  const config = getSupersetSyncConfig();
  const auth = config.superset.auth;
  const password = secretValue("password");
  const cookie = secretValue("cookie_header");
  const bearer = secretValue("access_token");
  const hasLogin = Boolean(auth.username && password);
  if (auth.mode === "login" && !hasLogin) {
    throw new Error("Mode login membutuhkan nama pengguna dan kata sandi Superset.");
  }
  if (auth.mode === "cookie" && !cookie) {
    throw new Error("Cookie Superset belum dikonfigurasi.");
  }
  if (auth.mode === "bearer" && !bearer) {
    throw new Error("Access token Superset belum dikonfigurasi.");
  }
  if (auth.mode === "auto" && !hasLogin && !cookie && !bearer) {
    throw new Error("Kredensial Superset belum dikonfigurasi.");
  }
}

function resolvedAuth(config: SupersetSyncConfig) {
  return {
    ...config.superset.auth,
    password: secretValue("password"),
    cookie_header: secretValue("cookie_header"),
    access_token: secretValue("access_token"),
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutSeconds: number) {
  return fetch(url, {
    ...init,
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutSeconds * 1_000),
  });
}

async function authenticatedHeaders(config: SupersetSyncConfig): Promise<Headers> {
  const auth = resolvedAuth(config);
  const headers = new Headers({
    Accept: "application/json",
    Referer: config.superset.base_url,
    "User-Agent": "Mozilla/5.0 (compatible; WIOM-Control-Tower/1.0)",
  });
  if (auth.mode === "bearer") {
    if (!auth.access_token) throw new Error("Access token belum diisi.");
    headers.set("Authorization", `Bearer ${auth.access_token}`);
    return headers;
  }

  const shouldLogin = auth.mode === "login"
    || (auth.mode === "auto" && Boolean(auth.username && auth.password));
  if (shouldLogin) {
    if (!auth.username || !auth.password) throw new Error("Nama pengguna dan kata sandi Superset wajib diisi.");
    const response = await fetchWithTimeout(
      `${config.superset.base_url.replace(/\/$/, "")}/api/v1/security/login`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Referer: config.superset.base_url,
          "User-Agent": "Mozilla/5.0 (compatible; WIOM-Control-Tower/1.0)",
        },
        body: JSON.stringify({
          username: auth.username,
          password: auth.password,
          provider: auth.provider,
          refresh: true,
        }),
      },
      config.superset.timeout_sec,
    );
    if (!response.ok) throw new Error(`Login Superset ditolak (HTTP ${response.status}).`);
    const body = await response.json().catch(() => ({})) as { access_token?: string };
    if (!body.access_token) throw new Error("Superset tidak mengembalikan access token.");
    headers.set("Authorization", `Bearer ${body.access_token}`);
    return headers;
  }

  if (!auth.cookie_header) throw new Error("Cookie Superset belum diisi.");
  headers.set("Cookie", auth.cookie_header);
  return headers;
}

export async function testSupersetConnection() {
  const config = getSupersetSyncConfig();
  const base = config.superset.base_url.replace(/\/$/, "");
  const started = Date.now();

  const healthResponse = await fetchWithTimeout(`${base}/health`, { headers: { Accept: "application/json,text/plain" } }, Math.min(30, config.superset.timeout_sec));
  if (!healthResponse.ok) throw new Error(`Health Superset gagal (HTTP ${healthResponse.status}).`);

  const headers = await authenticatedHeaders(config);
  const identityResponse = await fetchWithTimeout(`${base}/api/v1/me/`, { headers }, config.superset.timeout_sec);
  if (!identityResponse.ok) throw new Error(`Sesi Superset tidak valid (HTTP ${identityResponse.status}).`);
  const identityBody = await identityResponse.json().catch(() => ({})) as {
    result?: { username?: string; email?: string; first_name?: string; last_name?: string };
  };

  const datasets = [];
  for (const job of config.jobs.filter((item) => item.enabled)) {
    const id = String(job.dataset.id);
    if (!/^\d+$/.test(id)) {
      datasets.push({ job: job.name, dataset_id: id, ok: false, error: "Dataset ID belum diisi." });
      continue;
    }
    try {
      const response = await fetchWithTimeout(`${base}/api/v1/dataset/${id}`, { headers }, config.superset.timeout_sec);
      datasets.push({
        job: job.name,
        dataset_id: Number(id),
        ok: response.ok,
        error: response.ok ? undefined : `HTTP ${response.status}`,
      });
    } catch (error) {
      datasets.push({ job: job.name, dataset_id: Number(id), ok: false, error: (error as Error).message });
    }
  }

  const result = identityBody.result ?? {};
  return {
    ok: datasets.filter((dataset) => config.jobs.find((job) => job.name === dataset.job)?.required)
      .every((dataset) => dataset.ok),
    latency_ms: Date.now() - started,
    identity: {
      username: result.username || result.email || [result.first_name, result.last_name].filter(Boolean).join(" ") || "Superset user",
    },
    datasets,
    tested_at: new Date().toISOString(),
  };
}

export async function supersetProxyFetch(relativePath: string, init: RequestInit = {}) {
  const config = getSupersetSyncConfig();
  const headers = await authenticatedHeaders(config);
  const incoming = new Headers(init.headers);
  incoming.forEach((value, key) => headers.set(key, value));
  const url = `${config.superset.base_url.replace(/\/$/, "")}/${relativePath.replace(/^\/+/, "")}`;
  return fetchWithTimeout(url, { ...init, headers }, config.superset.timeout_sec);
}
