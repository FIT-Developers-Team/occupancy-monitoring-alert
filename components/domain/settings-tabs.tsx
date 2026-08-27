"use client";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useT } from "@/lib/i18n-client";
import { formatters } from "@/lib/utils";

function SettingsPanelLoading() {
  return (
    <div className="settings-panel-loading" role="status" aria-live="polite" aria-label="Memuat pengaturan">
      <div className="settings-panel-loading-head"><span /><strong /></div>
      <div className="settings-panel-loading-grid"><span /><span /></div>
      <span className="sr-only">Memuat pengaturan…</span>
    </div>
  );
}
const SupersetSyncSettings = dynamic(
  () => import("@/components/domain/superset-sync-settings"),
  { loading: () => <SettingsPanelLoading /> },
);

const EscalationSettings = dynamic(
  () => import("@/components/domain/escalation-settings"),
  { loading: () => <SettingsPanelLoading /> },
);

const AccountManagement = dynamic(
  () => import("@/components/domain/account-management"),
  { loading: () => <SettingsPanelLoading /> },
);

const CapacitySettings = dynamic(
  () => import("@/components/domain/capacity-settings"),
  { loading: () => <SettingsPanelLoading /> },
);

const SkuStandardSettings = dynamic(
  () => import("@/components/domain/sku-standard-settings"),
  { loading: () => <SettingsPanelLoading /> },
);

type Severity = "INFO" | "WARNING" | "HIGH" | "CRITICAL" | "EMERGENCY";
const SEVERITIES: Severity[] = ["INFO", "WARNING", "HIGH", "CRITICAL", "EMERGENCY"];

interface OverflowSeverity {
  over_pct: number;
  single_basis: Severity;
  dual_basis: Severity;
  dual_at_capacity: Severity;
  single_at_capacity: Severity;
  single_measurable: Severity;
  threshold_only: Severity;
}
interface Thresholds {
  default: { monitor: number; warning: number; critical: number; breach: number; hysteresis_buffer: number };
  overrides: Record<string, Partial<{ monitor: number; warning: number; critical: number; breach: number; hysteresis_buffer: number }>>;
  /** Ditulis balik apa adanya saat menyimpan; hanya blok di bawah yang diedit. */
  sloc_alerts?: {
    enabled: boolean;
    /** Jendela pergerakan yang diperiksa tiap evaluasi (jam). */
    window_hours: number;
    max_alerts: number;
    /** Tidak lagi dipakai; dipertahankan agar konfigurasi lama tetap terbaca. */
    min_pct: number;
  };
  overflow_severity?: OverflowSeverity;
}

// Urut dari yang paling berat ke yang paling ringan, sehingga tangganya
// terbaca sebagai tangga: dua basis lewat → dua basis pas di kapasitas → satu
// basis lewat → satu basis pas di kapasitas.
const OVERFLOW_ROWS: Array<{ key: keyof Omit<OverflowSeverity, "over_pct">; labelKey: string; hintKey: string; locked?: boolean }> = [
  { key: "dual_basis", labelKey: "set.ui.overflow.dual", hintKey: "set.ui.overflow.dualHint" },
  { key: "dual_at_capacity", labelKey: "set.ui.overflow.dualAt", hintKey: "set.ui.overflow.dualAtHint", locked: true },
  { key: "single_basis", labelKey: "set.ui.overflow.single", hintKey: "set.ui.overflow.singleHint" },
  { key: "single_at_capacity", labelKey: "set.ui.overflow.singleAt", hintKey: "set.ui.overflow.singleAtHint" },
  { key: "single_measurable", labelKey: "set.ui.overflow.ambiguous", hintKey: "set.ui.overflow.ambiguousHint" },
  { key: "threshold_only", labelKey: "set.ui.overflow.thresholdOnly", hintKey: "set.ui.overflow.thresholdOnlyHint" },
];

const SEVERITY_TONE_CLASS: Record<Severity, string> = {
  INFO: "severity-normal",
  WARNING: "severity-monitor",
  HIGH: "severity-warning",
  CRITICAL: "severity-critical",
  EMERGENCY: "severity-breach",
};
export interface ConfigStorage {
  /** Apakah penyimpanan permanen dapat ditulis pada deployment ini. */
  writable: boolean;
  /** Apakah deployment dapat membuktikan storage tahan penggantian container. */
  durable: boolean;
  /** Kapan salinan pengaman sebelum pemulihan terakhir dibuat, bila ada. */
  snapshotAt: string | null;
}
const TKEYS = ["monitor", "warning", "critical", "breach", "hysteresis_buffer"] as const;

/**
 * Cadangan konfigurasi — unduh, pulihkan, dan salin sebagai environment.
 *
 * Sebelum ini, memindahkan Pengaturan dari container lama ke volume permanen
 * hanya mungkin lewat `docker cp` di terminal server. Admin yang hanya
 * memegang panel deployment terpaksa mengetik ulang semuanya setelah setiap
 * deploy. Tombol di bawah menggantikan seluruh langkah itu.
 *
 * PEMULIHAN DIPERIKSA SEBELUM DIJALANKAN
 * --------------------------------------
 * Versi sebelumnya mengirim berkas apa pun yang dipilih langsung ke server,
 * meminta konfirmasi lewat satu kotak `confirm()` yang tidak menyebutkan
 * apa-apa, lalu memuat ulang halaman tanpa peduli hasilnya. Bila isinya tidak
 * cocok — cadangan dari versi lama, berkas yang disunting, unduhan yang
 * terpotong — konfigurasi rusak itu ditulis ke volume dan SETIAP halaman
 * berubah menjadi layar galat, termasuk halaman ini.
 *
 * Sekarang berkasnya diperiksa lebih dulu (PUT tanpa menulis apa pun), isinya
 * ditampilkan — dibuat kapan, memuat seksi apa saja — dan daftar akun hanya
 * ikut dipulihkan bila dicentang secara sadar.
 */
interface RestorePreview {
  created_at: string;
  files: string[];
  has_accounts: boolean;
  raw: string;
}

const FILE_LABELS: Record<string, string> = {
  "thresholds.json": "set.ui.tab.thresholds",
  "capacity.json": "set.ui.tab.capacity",
  "sku-standards.json": "set.ui.tab.sku",
  "warehouses.json": "set.ui.backup.file.warehouses",
  "recipients.json": "set.ui.tab.recipients",
  "rules.json": "set.ui.backup.file.rules",
  "superset-sync.json": "set.ui.tab.sync",
  ".superset-sync.secrets.json": "set.ui.backup.file.secrets",
  "accounts.json": "set.ui.tab.accounts",
};

function ConfigBackupPanel({ durable, snapshotAt }: { durable: boolean; snapshotAt: string | null }) {
  const { t, lang } = useT();
  const f = formatters(lang);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [envValue, setEnvValue] = useState("");
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [withAccounts, setWithAccounts] = useState(false);
  const [report, setReport] = useState<{ restored: string[]; skipped: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function download() {
    setBusy(true); setNote(""); setError("");
    try {
      const response = await fetch("/api/config/backup", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `wiom-config-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setNote("set.ui.backup.downloaded");
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyEnv() {
    setBusy(true); setNote(""); setError("");
    try {
      const response = await fetch("/api/config/backup?format=env", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = await response.text();
      setEnvValue(value);
      // Clipboard API hanya tersedia pada konteks aman; nilainya tetap
      // ditampilkan agar tetap dapat disalin manual bila ditolak browser.
      try {
        await navigator.clipboard.writeText(value);
        setNote("set.ui.backup.copied");
      } catch {
        setNote("set.ui.backup.copyManual");
      }
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Periksa berkas tanpa menulis apa pun, lalu tampilkan isinya. */
  async function inspect(file: File) {
    setBusy(true); setNote(""); setError(""); setReport(null); setPreview(null);
    try {
      const raw = await file.text();
      const response = await fetch("/api/config/backup", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      setPreview({
        created_at: body.created_at,
        files: body.files ?? [],
        has_accounts: Boolean(body.has_accounts),
        raw,
      });
      setWithAccounts(false);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Kembalikan konfigurasi ke keadaan sesaat sebelum pemulihan terakhir. */
  async function undoRestore() {
    if (!window.confirm(t("set.ui.backup.undoConfirm"))) return;
    setBusy(true); setNote(""); setError(""); setPreview(null);
    try {
      const response = await fetch("/api/config/backup?undo=1", { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      setReport({ restored: body.restored ?? [], skipped: [] });
      setNote("set.ui.backup.undone");
      window.setTimeout(() => window.location.reload(), 1600);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmRestore() {
    if (!preview) return;
    setBusy(true); setNote(""); setError("");
    try {
      const response = await fetch(`/api/config/backup${withAccounts ? "?accounts=1" : ""}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: preview.raw,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      setPreview(null);
      setReport({
        restored: body.restored ?? [],
        skipped: (body.skipped ?? []).map((entry: { file: string }) => entry.file),
      });
      setNote("set.ui.backup.restored");
      // Seluruh tab memegang salinan konfigurasi di state; memuat ulang jauh
      // lebih jujur daripada menambal sebagiannya.
      window.setTimeout(() => window.location.reload(), 1600);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card card-pad space-y-3">
      <div>
        <div className="panel-title">{t("set.ui.backup.title")}</div>
        <p className="mt-1 text-[11.5px]" style={{ color: "var(--text-muted)" }}>
          {t(durable ? "set.ui.backup.intro" : "set.ui.backup.introEphemeral")}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={download}>
          {t("set.ui.backup.download")}
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={copyEnv}>
          {t("set.ui.backup.copyEnv")}
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
          {t("set.ui.backup.restore")}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void inspect(file);
          }}
        />
        {/* Salinan pengaman yang hanya ada di disk sama saja dengan tidak ada:
            admin yang baru memulihkan berkas yang salah tidak punya akses shell
            ke server — itu justru alasan seluruh fitur ini dibuat. */}
        {snapshotAt && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void undoRestore()}>
            {t("set.ui.backup.undo")} · <span className="num">{f.dateTime(snapshotAt)}</span>
          </button>
        )}
      </div>

      {preview && (
        <div className="backup-preview" role="group" aria-label={t("set.ui.backup.previewTitle")}>
          <div className="backup-preview-head">
            <strong>{t("set.ui.backup.previewTitle")}</strong>
            <span className="num">{f.dateTime(preview.created_at)}</span>
          </div>
          <p>{t("set.ui.backup.previewChecked")}</p>
          <div className="backup-preview-files">
            {preview.files.map((file) => (
              <span key={file} className="chip">{t(FILE_LABELS[file] ?? file, file)}</span>
            ))}
          </div>
          {preview.has_accounts && (
            <label className="backup-preview-accounts">
              <input
                type="checkbox"
                checked={withAccounts}
                onChange={(event) => setWithAccounts(event.target.checked)}
              />
              <span>{t("set.ui.backup.includeAccounts")}</span>
            </label>
          )}
          <p className="backup-preview-warn">{t("set.ui.backup.previewWarn")}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void confirmRestore()}>
              {t("set.ui.backup.previewConfirm")}
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setPreview(null)}>
              {t("set.ui.backup.previewCancel")}
            </button>
          </div>
        </div>
      )}

      {report && (
        <div className="backup-preview" role="status">
          <div className="backup-preview-head">
            <strong>{t("set.ui.backup.reportTitle")}</strong>
          </div>
          <div className="backup-preview-files">
            {report.restored.map((file) => (
              <span key={file} className="chip">{t(FILE_LABELS[file] ?? file, file)}</span>
            ))}
          </div>
          {report.skipped.length > 0 && (
            <p>
              {t("set.ui.backup.reportSkipped")}{" "}
              {report.skipped.map((file) => t(FILE_LABELS[file] ?? file, file)).join(", ")}
            </p>
          )}
        </div>
      )}

      {envValue && (
        <label className="block space-y-1">
          <span className="eyebrow">{t("set.ui.backup.envHint")}</span>
          <textarea
            className="input num"
            readOnly
            rows={3}
            value={envValue}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      )}
      {note && <p className="settings-message" role="status">{t(note, note)}</p>}
      {error && <p className="settings-message is-error" role="alert">{t(error, error)}</p>}
    </div>
  );
}

export default function SettingsTabs({ storage }: { storage: ConfigStorage }) {
  const { t } = useT();
  const [tab, setTab] = useState<
    "accounts" | "sync" | "thresholds" | "capacity" | "sku" | "recipients"
  >("accounts");
  const [thresholds, setThresholds] = useState<Thresholds | null>(null);
  const [warehouses, setWarehouses] = useState<string[]>([]);
  const [msg, setMsg] = useState("");
  const [msgIsError, setMsgIsError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      if (tab === "sync" || tab === "capacity" || tab === "sku") return;
      if (tab === "thresholds" && !thresholds) {
        const [thresholdBody, warehouseBody] = await Promise.all([
          fetch("/api/config/thresholds").then((response) => response.json()),
          fetch("/api/config/warehouses").then((response) => response.json()),
        ]);
        if (!active) return;
        setThresholds(thresholdBody.data ?? null);
        setWarehouses((warehouseBody.data?.warehouses ?? []).map((item: { code: string }) => item.code));
      }
    })().catch(() => { setMsg("set.ui.loadError"); setMsgIsError(true); });
    return () => { active = false; };
    // Each tab is fetched only when first opened. Loaded state is checked from
    // the render that changed `tab`, avoiding a heavy all-at-once settings query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function save(section: string, data: unknown) {
    setBusy(true); setMsg(""); setMsgIsError(false);
    const res = await fetch(`/api/config/${section}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    // Pesan galat dari server dibuang begitu saja sebelumnya, sehingga sebuah
    // ambang yang tidak berurutan hanya menghasilkan "gagal disimpan" tanpa
    // menyebutkan nilai mana yang salah — dan admin harus menebaknya.
    const body = await res.json().catch(() => ({} as { error?: string }));
    setBusy(false);
    setMsgIsError(!res.ok);
    setMsg(res.ok ? "set.ui.saved" : (body?.error || "set.ui.saveError"));
  }

  const tabs = [
    { id: "accounts" as const, label: t("set.ui.tab.accounts") },
    { id: "sync" as const, label: t("set.ui.tab.sync", "Superset Sync") },
    { id: "thresholds" as const, label: t("set.ui.tab.thresholds") },
    { id: "capacity" as const, label: t("set.ui.tab.capacity") },
    // Kapasitas mengatur penyebut rasio okupansi, Standar SKU mengatur
    // pembilangnya. Bersebelahan supaya hubungan itu terbaca dari tab strip.
    { id: "sku" as const, label: t("set.ui.tab.sku") },
    { id: "recipients" as const, label: t("set.ui.tab.recipients") },
  ];

  const overflow = thresholds?.overflow_severity;
  const setOverflow = (patch: Partial<OverflowSeverity>) => {
    if (!thresholds?.overflow_severity) return;
    setThresholds({
      ...thresholds,
      overflow_severity: { ...thresholds.overflow_severity, ...patch },
    });
  };

  return (
    <div className="space-y-4">
      <div className="settings-tabbar" role="tablist" aria-label={t("set.ui.tabsLabel")}>
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`btn btn-sm ${tab === t.id ? "btn-primary" : ""}`}
            onClick={() => { setTab(t.id); setMsg(""); setMsgIsError(false); }}>
            {t.label}
          </button>
        ))}
      </div>
      {msg && tab !== "sync" && (
        <p
          className={`settings-message${msgIsError ? " is-error" : ""}`}
          role={msgIsError ? "alert" : "status"}
        >
          {t(msg, msg)}
        </p>
      )}

      {/* Jalur normal tidak berkata apa-apa: admin tidak perlu tahu di mana
          berkasnya disimpan. Peringatan hanya muncul bila penyimpanan tidak
          dapat ditulis — di situ setiap perubahan akan hilang saat container
          dibuat ulang, dan itu harus diketahui sebelum menyimpan. */}
      {!storage.durable && (
        <div className="config-storage-note is-error" role="alert">
          <span className="eyebrow">{t("set.ui.storage.title")}</span>
          <p>{t(storage.writable ? "set.ui.storage.notPersistent" : "set.ui.storage.readOnly")}</p>
        </div>
      )}

      {/* Selalu tampil, bukan hanya saat storage bermasalah: cadangan yang
          berguna adalah cadangan yang dibuat SEBELUM ada yang hilang. */}
      <ConfigBackupPanel durable={storage.durable} snapshotAt={storage.snapshotAt} />

      {tab === "sync" && <SupersetSyncSettings />}

      {tab === "accounts" && <AccountManagement />}

      {tab === "recipients" && <EscalationSettings />}

      {tab === "thresholds" && !thresholds && <SettingsPanelLoading />}

      {tab === "capacity" && <CapacitySettings />}

      {tab === "sku" && <SkuStandardSettings />}

      {/* ================= AMBANG ================= */}
      {tab === "thresholds" && thresholds && (
        <div className="space-y-4">
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("set.ui.threshold.scope")}</th>
                  <th>{t("set.ui.threshold.monitor")}</th>
                  <th>{t("set.ui.threshold.warning")}</th>
                  <th>{t("set.ui.threshold.critical")}</th>
                  <th>{t("set.ui.threshold.breach")}</th>
                  <th>{t("set.ui.threshold.hysteresis")}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="font-semibold">{t("set.ui.threshold.default")}</td>
                  {TKEYS.map((k) => (
                    <td key={k}>
                      <input type="number" className="input num w-20" value={thresholds.default[k]}
                        onChange={(e) => setThresholds({
                          ...thresholds,
                          default: { ...thresholds.default, [k]: Number(e.target.value) },
                        })} />
                    </td>
                  ))}
                </tr>
                {warehouses.map((w) => {
                  const o = thresholds.overrides[w] ?? {};
                  return (
                    <tr key={w}>
                      <td className="num font-semibold">{w}</td>
                      {TKEYS.map((k) => (
                        <td key={k}>
                          <input type="number" className="input num w-20"
                            placeholder={String(thresholds.default[k])}
                            value={o[k] ?? ""}
                            onChange={(e) => {
                              const val = e.target.value;
                              const next = { ...o };
                              if (val === "") delete next[k];
                              else next[k] = Number(val);
                              const overrides = { ...thresholds.overrides };
                              if (Object.keys(next).length) overrides[w] = next;
                              else delete overrides[w];
                              setThresholds({ ...thresholds, overrides });
                            }} />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            {t("set.ui.threshold.hint")}
          </p>

          {/* Ambang di atas menjawab "kapan sesuatu layak diberi alert". Blok
              ini menjawab "seberapa buruk" — dan itu ditentukan oleh berapa
              banyak basis yang mencapai/melewati kapasitas, bukan satu angka. */}
          {overflow && (
            <div className="card card-pad space-y-3">
              <div>
                <div className="panel-title">{t("set.ui.overflow.title")}</div>
                <p className="mt-1 text-[11.5px]" style={{ color: "var(--text-muted)" }}>
                  {t("set.ui.overflow.intro")}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                <span className="eyebrow">{t("set.ui.overflow.overPct")}</span>
                <input type="number" min={100} max={100} step={1} className="input num w-24"
                  value={overflow.over_pct} readOnly disabled aria-label={t("set.ui.overflow.overPct")} />
                <span style={{ color: "var(--text-muted)" }}>{t("set.ui.overflow.overPctHint")}</span>
              </div>
              <div className="overflow-severity-grid">
                {OVERFLOW_ROWS.map((row) => (
                  <div key={row.key} className="overflow-severity-row">
                    <div className="min-w-0">
                      <strong>{t(row.labelKey)}</strong>
                      <p>{t(row.hintKey)}</p>
                    </div>
                    <div className="overflow-severity-pick">
                      <span className={`badge badge-${SEVERITY_TONE_CLASS[overflow[row.key]].replace("severity-", "")}`}>
                        {t(`severity.${overflow[row.key]}`)}
                      </span>
                      <select className="input w-36" value={overflow[row.key]} disabled={row.locked}
                        onChange={(e) => setOverflow({ [row.key]: e.target.value as Severity })}>
                        {SEVERITIES.map((value) => (
                          <option key={value} value={value}>{t(`severity.${value}`)}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <button className="btn btn-primary" disabled={busy}
            onClick={() => save("thresholds", thresholds)}>
            {t("set.ui.threshold.save")}
          </button>
        </div>
      )}

    </div>
  );
}
