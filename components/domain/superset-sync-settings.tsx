"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n-client";
import type {
  SupersetSyncConfig,
  SupersetSyncJob,
  SupersetSyncSecretKey,
  SupersetSyncStatus,
} from "@/lib/superset-sync";

type SecretState = Record<SupersetSyncSecretKey, {
  configured: boolean;
  source: "file" | "environment" | null;
}>;

interface SettingsResponse {
  config: SupersetSyncConfig;
  secret_state: SecretState;
}

interface StatusResponse {
  status: SupersetSyncStatus;
  history: {
    last_snapshot: string | null;
    snapshot_rows: number;
    recent_syncs: Array<{
      job: string;
      mode: string;
      finished_at: string;
      rows_written: number;
      status: string;
    }>;
  } | null;
}

interface TestResult {
  ok: boolean;
  latency_ms: number;
  identity: { username: string };
  datasets: Array<{ job: string; dataset_id: string | number; ok: boolean; error?: string }>;
  tested_at: string;
}

const EMPTY_SECRET: Record<SupersetSyncSecretKey, string> = {
  password: "",
  cookie_header: "",
  access_token: "",
};

function formatDate(value?: string | null, lang: "id" | "en" = "id") {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatDuration(value?: number | null) {
  if (!value) return "—";
  if (value < 1_000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

export default function SupersetSyncSettings() {
  const { lang } = useT();
  const c = useCallback((id: string, en: string) => lang === "en" ? en : id, [lang]);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [secrets, setSecrets] = useState(EMPTY_SECRET);
  const [clearSecrets, setClearSecrets] = useState<SupersetSyncSecretKey[]>([]);
  const [busy, setBusy] = useState<"save" | "test" | "run" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const loadStatus = useCallback(async () => {
    const response = await fetch("/api/superset-sync/status", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || c("Status sync gagal dimuat.", "Sync status could not be loaded."));
    setStatus(body);
  }, [c]);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch("/api/superset-sync/config", { cache: "no-store" }).then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error);
        return body as SettingsResponse;
      }),
      fetch("/api/superset-sync/status", { cache: "no-store" }).then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error);
        return body as StatusResponse;
      }),
    ]).then(([config, currentStatus]) => {
      if (!active) return;
      setSettings(config);
      setStatus(currentStatus);
    }).catch((error) => {
      if (active) setNotice({ tone: "error", text: error.message || c("Konfigurasi gagal dimuat.", "Configuration could not be loaded.") });
    });
    return () => { active = false; };
  }, [c]);

  useEffect(() => {
    const state = status?.status.state;
    const workerReady = status?.status.worker.online && status.status.worker.ready;
    if (state !== "queued" && state !== "running" && workerReady) return;
    const timer = window.setInterval(
      () => { loadStatus().catch(() => undefined); },
      workerReady ? 2_500 : 5_000,
    );
    return () => window.clearInterval(timer);
  }, [
    loadStatus,
    status?.status.state,
    status?.status.worker.online,
    status?.status.worker.ready,
  ]);

  const updateConfig = (patch: Partial<SupersetSyncConfig>) => {
    setSettings((current) => current ? { ...current, config: { ...current.config, ...patch } } : current);
  };

  const updateJob = (index: number, patch: Partial<SupersetSyncJob>) => {
    setSettings((current) => {
      if (!current) return current;
      const jobs = [...current.config.jobs];
      jobs[index] = { ...jobs[index], ...patch };
      return { ...current, config: { ...current.config, jobs } };
    });
  };

  const updateDataset = (index: number, patch: Partial<SupersetSyncJob["dataset"]>) => {
    if (!settings) return;
    updateJob(index, { dataset: { ...settings.config.jobs[index].dataset, ...patch } });
  };

  const save = async (quiet = false): Promise<boolean> => {
    if (!settings) return false;
    setBusy("save");
    if (!quiet) setNotice(null);
    try {
      const response = await fetch("/api/superset-sync/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: settings.config,
          secrets,
          clear_secrets: clearSecrets,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setSettings(body);
      setSecrets(EMPTY_SECRET);
      setClearSecrets([]);
      if (!quiet) setNotice({ tone: "ok", text: c("Konfigurasi Superset tersimpan.", "Superset configuration saved.") });
      return true;
    } catch (error) {
      setNotice({ tone: "error", text: (error as Error).message || c("Konfigurasi gagal disimpan.", "Configuration could not be saved.") });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const testConnection = async () => {
    setTestResult(null);
    setNotice({ tone: "info", text: c("Menyimpan lalu menguji koneksi…", "Saving and testing the connection…") });
    const saved = await save(true);
    if (!saved) return;
    setBusy("test");
    try {
      const response = await fetch("/api/superset-sync/test", { method: "POST" });
      const body = await response.json() as TestResult & { error?: string };
      if (!response.ok && !Array.isArray(body.datasets)) {
        throw new Error(body.error || c("Koneksi belum valid.", "The connection is not valid yet."));
      }
      setTestResult(body);
      setNotice({
        tone: body.ok ? "ok" : "error",
        text: body.ok
          ? c(`Terhubung sebagai ${body.identity.username}.`, `Connected as ${body.identity.username}.`)
          : c("Koneksi berhasil, tetapi dataset wajib belum dapat dibaca.", "Connected, but a required dataset is not readable."),
      });
    } catch (error) {
      setNotice({ tone: "error", text: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const runNow = async () => {
    const saved = await save(true);
    if (!saved) return;
    setBusy("run");
    setNotice(null);
    try {
      const response = await fetch("/api/superset-sync/run", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setNotice({
        tone: "ok",
        text: body.worker_started
          ? c(
            "Worker berhasil dimulai dan sinkronisasi masuk antrean.",
            "The worker started and synchronisation has been queued.",
          )
          : body.request?.reused
            ? c(
              "Permintaan yang sudah ada sedang diproses.",
              "The existing request is being processed.",
            )
            : c("Sinkronisasi masuk antrean.", "Synchronisation has been queued."),
      });
      await loadStatus();
    } catch (error) {
      setNotice({ tone: "error", text: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const authSecret: SupersetSyncSecretKey = useMemo(() => {
    const mode = settings?.config.superset.auth.mode;
    return mode === "cookie" ? "cookie_header" : mode === "bearer" ? "access_token" : "password";
  }, [settings?.config.superset.auth.mode]);

  if (!settings) {
    return (
      <div className="sync-settings-loading" aria-live="polite">
        <div className="sync-loading-line" />
        <div className="sync-loading-grid"><span /><span /><span /></div>
      </div>
    );
  }

  const runtime = status?.status;
  const workerOnline = runtime?.worker.online === true;
  const workerReady = workerOnline && runtime?.worker.ready === true;
  const stateCopy: Record<SupersetSyncStatus["state"], [string, string]> = {
    idle: ["Siap", "Ready"],
    queued: ["Dalam antrean", "Queued"],
    running: ["Sedang sinkron", "Synchronising"],
    succeeded: ["Berhasil", "Succeeded"],
    failed: ["Gagal", "Failed"],
    paused: ["Dijeda", "Paused"],
    not_started: ["Belum berjalan", "Not started"],
  };
  const stateLabel = !runtime
    ? c("Memuat", "Loading")
    : !workerOnline
      ? c("Worker offline", "Worker offline")
      : !workerReady
        ? c("Worker belum siap", "Worker not ready")
        : c(...stateCopy[runtime.state]);
  const stateTone = !workerReady || runtime?.state === "failed" ? "error"
    : runtime?.state === "succeeded" || runtime?.state === "running" ? "ok"
    : "neutral";

  return (
    <div className="sync-settings">
      <section className="sync-status-panel">
        <div className="sync-status-main">
          <div className={`sync-state sync-state-${stateTone}`}>
            <span aria-hidden />
            {stateLabel}
          </div>
          <div>
            <h3>{c("Superset langsung ke WIOM", "Superset directly to WIOM")}</h3>
            <p>{settings.config.superset.base_url.replace(/^https?:\/\//, "")}</p>
          </div>
        </div>
        <dl className="sync-status-facts">
          <div>
            <dt>{c("Sync terakhir", "Last sync")}</dt>
            <dd>{formatDate(runtime?.finished_at || status?.history?.last_snapshot, lang)}</dd>
          </div>
          <div>
            <dt>{c("Baris ditulis", "Rows written")}</dt>
            <dd className="num">{runtime?.rows_written?.toLocaleString(lang === "en" ? "en-GB" : "id-ID") ?? "—"}</dd>
          </div>
          <div>
            <dt>{c("Durasi", "Duration")}</dt>
            <dd className="num">{formatDuration(runtime?.duration_ms)}</dd>
          </div>
          <div>
            <dt>{c("Jadwal berikut", "Next run")}</dt>
            <dd>{formatDate(runtime?.next_run_at, lang)}</dd>
          </div>
        </dl>
        <div className="sync-status-actions">
          <button className="btn" disabled={busy !== null} onClick={testConnection}>
            {busy === "test" ? c("Menguji…", "Testing…") : c("Uji koneksi", "Test connection")}
          </button>
          <button
            className="btn"
            disabled={busy !== null || !settings.config.schedule.enabled}
            title={!workerReady
              ? c(
                "WIOM akan mencoba memulai worker lalu menjalankan sync.",
                "WIOM will try to start the worker before synchronising.",
              )
              : undefined}
            onClick={runNow}
          >
            {busy === "run"
              ? workerReady
                ? c("Mengantrekan…", "Queuing…")
                : c("Memulai worker…", "Starting worker…")
              : workerReady
                ? c("Sync sekarang", "Sync now")
                : c("Mulai & sync", "Start & sync")}
          </button>
          <button className="btn btn-primary" disabled={busy !== null} onClick={() => save()}>
            {busy === "save" ? c("Menyimpan…", "Saving…") : c("Simpan", "Save")}
          </button>
        </div>
      </section>

      {runtime && !workerReady && (
        <div className="sync-worker-alert" role="alert">
          <div>
            <strong>
              {workerOnline
                ? c("Worker belum siap", "Worker not ready")
                : c("Worker sinkronisasi tidak aktif", "Sync worker is offline")}
            </strong>
            <span>
              {runtime.worker.error
                || c(
                  "Tekan Mulai & sync untuk pemulihan otomatis. Jika gagal, periksa detail runtime deployment.",
                  "Select Start & sync for automatic recovery. If it fails, inspect the deployment runtime details.",
                )}
            </span>
          </div>
          <span className="chip num">
            {runtime.worker.heartbeat_at
              ? c("Heartbeat terputus", "Heartbeat lost")
              : c("Tanpa heartbeat", "No heartbeat")}
          </span>
        </div>
      )}

      {notice && (
        <div className={`sync-notice sync-notice-${notice.tone}`} role="status">
          {notice.text}
        </div>
      )}

      <div className="sync-config-grid">
        <section className="card card-pad sync-config-card">
          <div className="sync-card-head">
            <div>
              <span className="eyebrow">{c("Koneksi", "Connection")}</span>
              <h3>{c("Akun Superset", "Superset account")}</h3>
            </div>
            <span className="chip">{c("Tanpa Google Sheet", "No Google Sheets")}</span>
          </div>
          <div className="sync-form-grid">
            <label className="sync-field sync-field-wide">
              <span>URL Superset</span>
              <input
                className="input"
                type="url"
                value={settings.config.superset.base_url}
                onChange={(event) => updateConfig({
                  superset: { ...settings.config.superset, base_url: event.target.value },
                })}
                placeholder="https://superset.example.com"
              />
            </label>
            <label className="sync-field">
              <span>{c("Metode masuk", "Authentication")}</span>
              <select
                className="input"
                value={settings.config.superset.auth.mode}
                onChange={(event) => updateConfig({
                  superset: {
                    ...settings.config.superset,
                    auth: {
                      ...settings.config.superset.auth,
                      mode: event.target.value as SupersetSyncConfig["superset"]["auth"]["mode"],
                    },
                  },
                })}
              >
                <option value="auto">{c("Otomatis", "Automatic")}</option>
                <option value="login">{c("Nama pengguna + kata sandi", "Username + password")}</option>
                <option value="cookie">Session cookie / SSO</option>
                <option value="bearer">Bearer token</option>
              </select>
            </label>
            {(settings.config.superset.auth.mode === "auto" || settings.config.superset.auth.mode === "login") && (
              <>
                <label className="sync-field">
                  <span>{c("Provider", "Provider")}</span>
                  <select
                    className="input"
                    value={settings.config.superset.auth.provider}
                    onChange={(event) => updateConfig({
                      superset: {
                        ...settings.config.superset,
                        auth: {
                          ...settings.config.superset.auth,
                          provider: event.target.value as "db" | "ldap",
                        },
                      },
                    })}
                  >
                    <option value="db">Database</option>
                    <option value="ldap">LDAP</option>
                  </select>
                </label>
                <label className="sync-field">
                  <span>{c("Nama pengguna", "Username")}</span>
                  <input
                    className="input"
                    autoComplete="username"
                    value={settings.config.superset.auth.username}
                    onChange={(event) => updateConfig({
                      superset: {
                        ...settings.config.superset,
                        auth: { ...settings.config.superset.auth, username: event.target.value },
                      },
                    })}
                  />
                </label>
              </>
            )}
            <label className="sync-field sync-field-wide">
              <span>
                {authSecret === "password"
                  ? c("Kata sandi", "Password")
                  : authSecret === "cookie_header" ? "Cookie header" : "Access token"}
                {settings.secret_state[authSecret]?.configured && (
                  <small>{c(
                    `Tersimpan via ${settings.secret_state[authSecret].source === "environment" ? "environment" : "server"}`,
                    `Stored via ${settings.secret_state[authSecret].source === "environment" ? "environment" : "server"}`,
                  )}</small>
                )}
              </span>
              <div className="sync-secret-row">
                <input
                  className="input"
                  type={authSecret === "password" ? "password" : "text"}
                  autoComplete="new-password"
                  value={secrets[authSecret]}
                  placeholder={settings.secret_state[authSecret]?.configured
                    ? c("Tersimpan — isi hanya untuk mengganti", "Stored — enter a value only to replace")
                    : c("Belum diisi", "Not configured")}
                  onChange={(event) => {
                    setSecrets((current) => ({ ...current, [authSecret]: event.target.value }));
                    setClearSecrets((current) => current.filter((key) => key !== authSecret));
                  }}
                />
                {settings.secret_state[authSecret]?.configured
                  && settings.secret_state[authSecret]?.source !== "environment" && (
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    onClick={() => setClearSecrets((current) =>
                      current.includes(authSecret) ? current.filter((key) => key !== authSecret) : [...current, authSecret]
                    )}
                  >
                    {clearSecrets.includes(authSecret) ? c("Batal hapus", "Keep") : c("Hapus", "Clear")}
                  </button>
                )}
              </div>
            </label>
          </div>
          <p className="sync-helper">
            {c(
              "Kredensial tidak dikirim kembali ke browser dan disimpan terpisah dari konfigurasi publik.",
              "Credentials are never returned to the browser and are stored separately from public configuration.",
            )}
          </p>
        </section>

        <section className="card card-pad sync-config-card">
          <div className="sync-card-head">
            <div>
              <span className="eyebrow">{c("Otomasi", "Automation")}</span>
              <h3>{c("Jadwal & performa", "Schedule & performance")}</h3>
            </div>
            <label className="sync-toggle">
              <input
                type="checkbox"
                checked={settings.config.schedule.enabled}
                onChange={(event) => updateConfig({
                  schedule: { ...settings.config.schedule, enabled: event.target.checked },
                })}
              />
              <span>{settings.config.schedule.enabled ? c("Aktif", "Enabled") : c("Dijeda", "Paused")}</span>
            </label>
          </div>
          <div className="sync-form-grid">
            <label className="sync-field">
              <span>{c("Interval", "Interval")}</span>
              <select
                className="input"
                value={settings.config.schedule.interval_seconds}
                onChange={(event) => updateConfig({
                  schedule: { ...settings.config.schedule, interval_seconds: Number(event.target.value) },
                })}
              >
                <option value={60}>{c("Setiap 1 menit", "Every minute")}</option>
                <option value={300}>{c("Setiap 5 menit", "Every 5 minutes")}</option>
                <option value={900}>{c("Setiap 15 menit", "Every 15 minutes")}</option>
                <option value={1800}>{c("Setiap 30 menit", "Every 30 minutes")}</option>
                <option value={3600}>{c("Setiap 1 jam", "Every hour")}</option>
              </select>
            </label>
            <label className="sync-field">
              <span>{c("Percobaan ulang", "Retries")}</span>
              <input
                className="input num"
                type="number"
                min={1}
                max={8}
                value={settings.config.schedule.retry_count}
                onChange={(event) => updateConfig({
                  schedule: { ...settings.config.schedule, retry_count: Number(event.target.value) },
                })}
              />
            </label>
            <label className="sync-field">
              <span>{c("Batas waktu request", "Request timeout")}</span>
              <div className="sync-input-unit">
                <input
                  className="input num"
                  type="number"
                  min={5}
                  max={300}
                  value={settings.config.superset.timeout_sec}
                  onChange={(event) => updateConfig({
                    superset: { ...settings.config.superset, timeout_sec: Number(event.target.value) },
                  })}
                />
                <span>{c("detik", "sec")}</span>
              </div>
            </label>
            <label className="sync-field">
              <span>{c("Batas baris/request", "Rows per request")}</span>
              <input
                className="input num"
                type="number"
                min={1_000}
                max={1_000_000}
                step={1_000}
                value={settings.config.superset.server_row_cap}
                onChange={(event) => updateConfig({
                  superset: { ...settings.config.superset, server_row_cap: Number(event.target.value) },
                })}
              />
            </label>
          </div>
          <div className="sync-scope">
            <span>{c("Gudang yang disinkronkan", "Synchronised warehouses")}</span>
            <div>
              {settings.config.scope.location_ids.map((id) => <span key={id} className="chip num">{id}</span>)}
            </div>
          </div>
          <p className="sync-helper">
            {c(
              "Filter location_id selalu ditambahkan ke setiap dataset agar HUB dan lokasi di luar gudang tidak ikut ditarik.",
              "The location_id filter is always added to every dataset so HUBs and non-warehouse locations are excluded.",
            )}
          </p>
        </section>
      </div>

      <section className="sync-datasets">
        <div className="sync-section-head">
          <div>
            <span className="eyebrow">{c("Sumber data", "Data sources")}</span>
            <h3>{c("Dataset & chart Superset", "Superset datasets & charts")}</h3>
          </div>
          <p>{c("Dua sumber inti wajib aktif.", "The two core sources must remain enabled.")}</p>
        </div>
        <div className="sync-job-list">
          {settings.config.jobs.map((job, index) => {
            const latest = runtime?.jobs?.find((item) => item.name === job.name);
            const columns = Object.entries(job.dataset.columns);
            return (
              <article key={job.name} className={`sync-job ${job.enabled ? "" : "is-disabled"}`}>
                <div className="sync-job-head">
                  <label className="sync-toggle">
                    <input
                      type="checkbox"
                      checked={job.enabled}
                      disabled={job.required}
                      onChange={(event) => updateJob(index, { enabled: event.target.checked })}
                    />
                    <span>{job.enabled ? c("Aktif", "Enabled") : c("Nonaktif", "Disabled")}</span>
                  </label>
                  <div className="sync-job-title">
                    <h4>{job.label}</h4>
                    <span>{job.target_table} · {job.mode}</span>
                  </div>
                  <div className="sync-job-result">
                    <b className={latest?.status === "ERROR" ? "is-error" : ""}>{latest?.status ?? "—"}</b>
                    <span>{latest ? `${latest.rows_written.toLocaleString()} ${c("baris", "rows")}` : c("Belum ada hasil", "No result yet")}</span>
                  </div>
                </div>
                <div className="sync-job-fields">
                  <label className="sync-field">
                    <span>Dataset ID</span>
                    <input
                      className="input num"
                      inputMode="numeric"
                      value={String(job.dataset.id ?? "")}
                      onChange={(event) => updateDataset(index, { id: event.target.value })}
                    />
                  </label>
                  <label className="sync-field">
                    <span>Chart ID</span>
                    <input
                      className="input num"
                      inputMode="numeric"
                      value={job.dataset.chart_id == null ? "" : String(job.dataset.chart_id)}
                      onChange={(event) => updateDataset(index, {
                        chart_id: event.target.value === "" ? null : event.target.value,
                      })}
                    />
                  </label>
                  <label className="sync-check">
                    <input
                      type="checkbox"
                      checked={job.dataset.inherit_chart_filters}
                      onChange={(event) => updateDataset(index, { inherit_chart_filters: event.target.checked })}
                    />
                    <span>
                      {c("Ikuti filter chart tersimpan", "Use saved chart filters")}
                      <small>{c("Filter gudang tetap dipaksakan.", "Warehouse scope is still enforced.")}</small>
                    </span>
                  </label>
                </div>
                <details className="sync-mapping">
                  <summary>{c("Mapping kolom", "Column mapping")} <span>{columns.length}</span></summary>
                  <div className="sync-mapping-list">
                    <div className="sync-mapping-labels">
                      <span>{c("Kolom Superset", "Superset column")}</span>
                      <span>{c("Kolom WIOM", "WIOM column")}</span>
                    </div>
                    {columns.map(([source, target], columnIndex) => (
                      <div key={`${source}-${columnIndex}`} className="sync-mapping-row">
                        <input
                          className="input"
                          value={source}
                          aria-label={c("Kolom sumber Superset", "Superset source column")}
                          onChange={(event) => {
                            const next = { ...job.dataset.columns };
                            delete next[source];
                            next[event.target.value] = target;
                            updateDataset(index, { columns: next });
                          }}
                        />
                        <input
                          className="input"
                          value={target}
                          aria-label={c("Kolom target WIOM", "WIOM target column")}
                          onChange={(event) => updateDataset(index, {
                            columns: { ...job.dataset.columns, [source]: event.target.value },
                          })}
                        />
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          disabled={source === "location_id"}
                          onClick={() => {
                            const next = { ...job.dataset.columns };
                            delete next[source];
                            updateDataset(index, { columns: next });
                          }}
                        >
                          {c("Hapus", "Remove")}
                        </button>
                      </div>
                    ))}
                    <button
                      className="btn btn-sm sync-add-mapping"
                      type="button"
                      onClick={() => {
                        let key = "new_column";
                        let suffix = 1;
                        while (job.dataset.columns[key]) key = `new_column_${suffix++}`;
                        updateDataset(index, { columns: { ...job.dataset.columns, [key]: key } });
                      }}
                    >
                      {c("Tambah mapping", "Add mapping")}
                    </button>
                  </div>
                </details>
              </article>
            );
          })}
        </div>
      </section>

      {testResult && (
        <section className="sync-test-result card card-pad">
          <div className="sync-card-head">
            <div>
              <span className="eyebrow">{c("Hasil uji", "Test result")}</span>
              <h3>{testResult.identity.username}</h3>
            </div>
            <span className="chip num">{testResult.latency_ms} ms</span>
          </div>
          <div className="sync-test-datasets">
            {testResult.datasets.map((dataset) => (
              <div key={dataset.job}>
                <span className={`sync-test-dot ${dataset.ok ? "is-ok" : "is-error"}`} aria-hidden />
                <b>{settings.config.jobs.find((job) => job.name === dataset.job)?.label ?? dataset.job}</b>
                <span className="num">#{dataset.dataset_id || "—"}</span>
                <small>{dataset.ok ? c("Dapat dibaca", "Readable") : dataset.error}</small>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
