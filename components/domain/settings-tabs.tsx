"use client";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useT } from "@/lib/i18n-client";
import { fmtCapCbm } from "@/lib/utils";

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
  sloc_alerts?: { enabled: boolean; min_pct: number; max_alerts: number };
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
interface CapRule {
  scope: {
    wh?: string; zone?: string; rack_zone?: string; aisle?: string; bay?: string;
    level?: string; bin?: string; storage?: string; l1_category?: string;
  };
  set: { basis?: "qty" | "cbm"; max_qty?: number; max_cbm?: number; utilization_pct?: number; count?: boolean };
  note: string;
}
interface DisabledZone { wh: string; zone: string; note: string }
interface Capacity {
  basis_default: "qty" | "cbm";
  utilization_pct: number;
  count_statuses: string[];
  exclude_categories: string[];
  disabled_zones: DisabledZone[];
  rules: CapRule[];
}
export interface ConfigStorage {
  /** Apakah penyimpanan permanen dapat ditulis pada deployment ini. */
  writable: boolean;
  /** Apakah deployment dapat membuktikan storage tahan penggantian container. */
  durable: boolean;
}
interface CapMeta {
  warehouses: string[]; zones: Record<string, string[]>;
  rack_zones: Record<string, string[]>; levels: string[];
  storages: string[]; categories: string[]; statuses: string[];
}

const TKEYS = ["monitor", "warning", "critical", "breach", "hysteresis_buffer"] as const;

/**
 * Cadangan konfigurasi — unduh, pulihkan, dan salin sebagai environment.
 *
 * Sebelum ini, memindahkan Pengaturan dari container lama ke volume permanen
 * hanya mungkin lewat `docker cp` di terminal server. Admin yang hanya
 * memegang panel deployment terpaksa mengetik ulang semuanya setelah setiap
 * deploy. Tiga tombol di bawah menggantikan seluruh langkah itu.
 */
function ConfigBackupPanel({ durable }: { durable: boolean }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [envValue, setEnvValue] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function download() {
    setBusy(true); setNote("");
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
    } catch (error) {
      setNote((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyEnv() {
    setBusy(true); setNote("");
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
    } catch (error) {
      setNote((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function restore(file: File) {
    if (!window.confirm(t("set.ui.backup.restoreConfirm"))) return;
    setBusy(true); setNote("");
    try {
      const response = await fetch("/api/config/backup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await file.text(),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      setNote("set.ui.backup.restored");
      // Seluruh tab memegang salinan konfigurasi di state; memuat ulang jauh
      // lebih jujur daripada menambal sebagiannya.
      window.setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      setNote((error as Error).message);
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
            if (file) void restore(file);
          }}
        />
      </div>
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
    </div>
  );
}

export default function SettingsTabs({ storage }: { storage: ConfigStorage }) {
  const { t } = useT();
  const [tab, setTab] = useState<"accounts" | "sync" | "thresholds" | "capacity" | "recipients">("accounts");
  const [thresholds, setThresholds] = useState<Thresholds | null>(null);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  // Index of a freshly appended override rule, so it can be focused once the
  // new row exists in the DOM.
  const [focusRuleIndex, setFocusRuleIndex] = useState<number | null>(null);
  const rulesBodyRef = useRef<HTMLTableSectionElement | null>(null);
  const [capMeta, setCapMeta] = useState<CapMeta | null>(null);
  const [warehouses, setWarehouses] = useState<string[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      if (tab === "sync") return;
      if (tab === "thresholds" && !thresholds) {
        const [thresholdBody, warehouseBody] = await Promise.all([
          fetch("/api/config/thresholds").then((response) => response.json()),
          fetch("/api/config/warehouses").then((response) => response.json()),
        ]);
        if (!active) return;
        setThresholds(thresholdBody.data ?? null);
        setWarehouses((warehouseBody.data?.warehouses ?? []).map((item: { code: string }) => item.code));
      } else if (tab === "capacity" && !capacity) {
        const body = await fetch("/api/config/capacity").then((response) => response.json());
        if (!active) return;
        setCapacity(body.data ?? null);
        setCapMeta(body.meta ?? null);
      }
    })().catch(() => setMsg("set.ui.loadError"));
    return () => { active = false; };
    // Each tab is fetched only when first opened. Loaded state is checked from
    // the render that changed `tab`, avoiding a heavy all-at-once settings query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function save(section: string, data: unknown) {
    setBusy(true); setMsg("");
    const res = await fetch(`/api/config/${section}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    await res.json().catch(() => ({}));
    setBusy(false);
    setMsg(res.ok ? "set.ui.saved" : "set.ui.saveError");
  }

  const tabs = [
    { id: "accounts" as const, label: t("set.ui.tab.accounts") },
    { id: "sync" as const, label: t("set.ui.tab.sync", "Superset Sync") },
    { id: "thresholds" as const, label: t("set.ui.tab.thresholds") },
    { id: "capacity" as const, label: t("set.ui.tab.capacity") },
    { id: "recipients" as const, label: t("set.ui.tab.recipients") },
  ];

  // ---- zona aktif/nonaktif ---------------------------------------------------
  // Config written before this feature has no disabled_zones; the API defaults
  // it, but read defensively so an older cached payload cannot crash the panel.
  const disabledZones: DisabledZone[] = capacity?.disabled_zones ?? [];
  const isZoneOff = (wh: string, zone: string) =>
    disabledZones.some((entry) => entry.wh === wh && entry.zone === zone);

  const toggleZone = (wh: string, zone: string) => {
    if (!capacity) return;
    const off = isZoneOff(wh, zone);
    setCapacity({
      ...capacity,
      disabled_zones: off
        ? disabledZones.filter((entry) => !(entry.wh === wh && entry.zone === zone))
        : [...disabledZones, { wh, zone, note: "" }],
    });
  };

  /**
   * Zones to offer per warehouse: what the master data currently holds, plus
   * anything already switched off. A zone that disappeared from the sync would
   * otherwise stay disabled with no way to see or undo it.
   */
  const zonesFor = (wh: string): Array<{ zone: string; orphan: boolean }> => {
    const known = capMeta?.zones?.[wh] ?? [];
    const orphans = disabledZones
      .filter((entry) => entry.wh === wh && !known.includes(entry.zone))
      .map((entry) => entry.zone);
    return [
      ...known.map((zone) => ({ zone, orphan: false })),
      ...orphans.map((zone) => ({ zone, orphan: true })),
    ];
  };

  // ---- helper kapasitas ------------------------------------------------------
  const addCapRule = () => {
    if (!capacity) return;
    setCapacity({ ...capacity, rules: [...capacity.rules, { scope: {}, set: {}, note: "" }] });
    setFocusRuleIndex(capacity.rules.length);
  };

  // Put the caret straight into the new row. Without this the rule appears at
  // the bottom of a long table and the admin has to hunt for it.
  useEffect(() => {
    if (focusRuleIndex === null) return;
    const row = rulesBodyRef.current?.children[focusRuleIndex] as HTMLElement | undefined;
    row?.querySelector<HTMLElement>("select, input")?.focus();
    row?.scrollIntoView({ block: "nearest" });
    setFocusRuleIndex(null);
  }, [focusRuleIndex]);

  const setCapRule = (i: number, patch: Partial<CapRule>) => {
    if (!capacity) return;
    const next = [...capacity.rules];
    next[i] = { ...next[i], ...patch };
    setCapacity({ ...capacity, rules: next });
  };
  const setScope = (i: number, key: keyof CapRule["scope"], val: string) => {
    if (!capacity) return;
    const scope = { ...capacity.rules[i].scope };
    if (val === "") delete scope[key]; else scope[key] = val;
    setCapRule(i, { scope });
  };
  const setSetNum = (i: number, key: "max_qty" | "max_cbm" | "utilization_pct", val: string) => {
    if (!capacity) return;
    const set = { ...capacity.rules[i].set };
    if (val === "") delete set[key]; else set[key] = Number(val);
    setCapRule(i, { set });
  };
  /**
   * A scope-less rule is the explicit admin-wide capacity override. Keeping it
   * as the first rule preserves the documented precedence: later WH/zone
   * rules can still be more specific than the global policy.
   */
  const setGlobalCapacity = (key: "max_qty" | "max_cbm", val: string) => {
    if (!capacity) return;
    const index = capacity.rules.findIndex((r) => Object.keys(r.scope).length === 0);
    if (index < 0) {
      if (val === "") return;
      setCapacity({
        ...capacity,
        rules: [{ scope: {}, set: { [key]: Number(val) }, note: t("set.ui.capacity.globalOverrideNote") }, ...capacity.rules],
      });
      return;
    }
    const rules = [...capacity.rules];
    const set = { ...rules[index].set };
    if (val === "") delete set[key]; else set[key] = Number(val);
    rules[index] = { ...rules[index], set };
    setCapacity({ ...capacity, rules });
  };
  const overflow = thresholds?.overflow_severity;
  const setOverflow = (patch: Partial<OverflowSeverity>) => {
    if (!thresholds?.overflow_severity) return;
    setThresholds({
      ...thresholds,
      overflow_severity: { ...thresholds.overflow_severity, ...patch },
    });
  };

  const toggleList = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  return (
    <div className="space-y-4">
      <div className="settings-tabbar" role="tablist" aria-label={t("set.ui.tabsLabel")}>
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`btn btn-sm ${tab === t.id ? "btn-primary" : ""}`}
            onClick={() => { setTab(t.id); setMsg(""); }}>
            {t.label}
          </button>
        ))}
      </div>
      {msg && tab !== "sync" && <p className="settings-message" role="status">{t(msg, msg)}</p>}

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
      <ConfigBackupPanel durable={storage.durable} />

      {tab === "sync" && <SupersetSyncSettings />}

      {tab === "accounts" && <AccountManagement />}

      {tab === "recipients" && <EscalationSettings />}

      {tab !== "sync" && (
        (tab === "thresholds" && !thresholds)
        || (tab === "capacity" && !capacity)
      ) && <SettingsPanelLoading />}

      {/* ================= KAPASITAS QTY/CBM ================= */}
      {tab === "capacity" && capacity && (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
            <div className="card card-pad space-y-3">
              <div className="panel-title">{t("set.ui.capacity.adminTitle")}</div>
              {Object.entries(capMeta?.rack_zones ?? {}).map(([key, values]) => (
                <datalist key={key} id={`racks-${key.replace("|", "-")}`}>
                  {values.map((value) => <option key={value} value={value} />)}
                </datalist>
              ))}
              <datalist id="capacity-levels">
                {(capMeta?.levels ?? []).map((level) => <option key={level} value={level} />)}
              </datalist>
              <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                {t("set.ui.capacity.defaultPrefix")} <span className="num">max_quantity</span> &amp;{" "}
                <span className="num">max_volume</span> {t("set.ui.capacity.defaultSuffix")}
              </p>
              <div className="capacity-warehouse-scope">
                <span className="eyebrow">{t("set.ui.capacity.availableWarehouses")}</span>
                <div>
                  {(capMeta?.warehouses ?? warehouses).map((warehouse) => (
                    <span key={warehouse} className="chip num">{warehouse}</span>
                  ))}
                </div>
              </div>
              <label className="block space-y-1">
                <span className="eyebrow">{t("set.ui.capacity.basis")}</span>
                <select className="input" value={capacity.basis_default}
                  onChange={(e) => setCapacity({ ...capacity, basis_default: e.target.value as "qty" | "cbm" })}>
                  <option value="qty">{t("set.ui.capacity.qtyOption")}</option>
                  <option value="cbm">{t("set.ui.capacity.cbmOption")}</option>
                </select>
              </label>
              {/* Faktor ini hanya mengalikan kapasitas CBM, dan angka hasil
                  kalinya itulah yang muncul sebagai penyebut di heatmap. Tanpa
                  keterangan di sini, "max CBM 0,0336" yang tampil "0,029"
                  terbaca sebagai konfigurasi yang tidak tersimpan. */}
              <label className="block space-y-1">
                <span className="eyebrow">{t("set.ui.capacity.volumeUtilisation")}</span>
                <input type="number" min={10} max={100} step={1} className="input num w-24"
                  value={capacity.utilization_pct}
                  onChange={(e) => setCapacity({ ...capacity, utilization_pct: Number(e.target.value) })} />
                <span className="field-hint">{t("set.ui.capacity.utilisationHint")}</span>
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(["max_qty", "max_cbm"] as const).map((key) => {
                  const global = capacity.rules.find((r) => Object.keys(r.scope).length === 0);
                  return (
                    <label key={key} className="block space-y-1">
                      <span className="eyebrow">
                        {key === "max_qty"
                          ? t("set.ui.capacity.globalQtyOverride")
                          : t("set.ui.capacity.globalCbmOverride")}
                      </span>
                      {/* step="0.001" menolak nilai seperti 0,0336 di
                          sebagian browser (stepMismatch). Kapasitas per-slot
                          memang serapat itu, jadi langkahnya dibebaskan. */}
                      <input type="number" min={0} step="any" inputMode="decimal"
                        className="input num w-full" placeholder={t("set.ui.capacity.supersetData")}
                        value={global?.set[key] ?? ""}
                        onChange={(e) => setGlobalCapacity(key, e.target.value)} />
                      {key === "max_cbm" && global?.set.max_cbm !== undefined && (
                        <span className="field-hint num">
                          {t("set.ui.capacity.effectivePreview")}{" "}
                          {fmtCapCbm(global.set.max_cbm * capacity.utilization_pct / 100)} m³
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
              <p className="text-[10.5px]" style={{ color: "var(--text-muted)" }}>
                {t("set.ui.capacity.emptyPrefix")} <span className="num">max_quantity</span> /{" "}
                <span className="num">max_volume</span> {t("set.ui.capacity.emptySuffix")}
              </p>
              <div className="space-y-1">
                <span className="eyebrow">{t("set.ui.capacity.countedStatuses")}</span>
                <div className="flex flex-wrap gap-2">
                  {(capMeta?.statuses ?? ["Available", "Bad", "Lost"]).map((s) => (
                    <label key={s} className="chip cursor-pointer gap-1.5">
                      <input type="checkbox" checked={capacity.count_statuses.includes(s)}
                        onChange={() => setCapacity({
                          ...capacity, count_statuses: toggleList(capacity.count_statuses, s),
                        })} />
                      {t(`set.ui.stockStatus.${s}`, s)}
                    </label>
                  ))}
                </div>
              </div>
              <div className="space-y-1">
                <span className="eyebrow">{t("set.ui.capacity.excludedCategories")}</span>
                <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border p-2"
                  style={{ borderColor: "var(--border)" }}>
                  {(capMeta?.categories ?? capacity.exclude_categories).map((c) => (
                    <label key={c} className="flex items-center gap-2 text-[11.5px]">
                      <input type="checkbox" checked={capacity.exclude_categories.includes(c)}
                        onChange={() => setCapacity({
                          ...capacity, exclude_categories: toggleList(capacity.exclude_categories, c),
                        })} />
                      <span className="truncate">{c}</span>
                    </label>
                  ))}
                </div>
              </div>

            </div>

            <div className="min-w-0 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="panel-title">{t("set.ui.capacity.overrideRules")}</div>
                  <p className="mt-0.5 text-[10.5px]" style={{ color: "var(--text-muted)" }}>
                    {t("set.ui.capacity.overrideHint")}
                  </p>
                </div>
                <span className="chip num">{capacity.rules.length}</span>
              </div>
              <div className="capacity-rules-wrap overflow-x-auto">
                <table className="tbl capacity-rules-table">
                  <thead>
                    <tr>
                      <th>{t("set.ui.column.warehouse")}</th><th>{t("set.ui.column.zone")}</th>
                      <th>{t("set.ui.column.rack")}</th><th>{t("set.ui.column.aisle")}</th>
                      <th>{t("set.ui.column.bay")}</th><th>{t("set.ui.column.level")}</th>
                      <th>{t("set.ui.column.bin")}</th><th>{t("set.ui.column.storage")}</th>
                      <th>{t("set.ui.column.category")}</th><th>{t("set.ui.column.basis")}</th>
                      <th>{t("set.ui.column.maxQty")}</th><th>{t("set.ui.column.maxCbm")}</th>
                      <th>{t("set.ui.column.utilisation")}</th><th>{t("set.ui.column.count")}</th>
                      <th>{t("set.ui.column.note")}</th><th></th>
                    </tr>
                  </thead>
                  <tbody ref={rulesBodyRef}>
                    {capacity.rules.map((r, i) => {
                      const catScoped = !!r.scope.l1_category;
                      return (
                        <tr key={i}>
                          <td>
                            <select className="input w-20" value={r.scope.wh ?? ""}
                              onChange={(e) => setScope(i, "wh", e.target.value)}>
                              <option value="">—</option>
                              {(capMeta?.warehouses ?? warehouses).map((w) => <option key={w}>{w}</option>)}
                            </select>
                          </td>
                          <td>
                            <input className="input num w-20" placeholder="SRA / SRA1"
                              list={r.scope.wh ? `zones-${r.scope.wh}` : undefined}
                              value={r.scope.zone ?? ""}
                              onChange={(e) => setScope(i, "zone", e.target.value.toUpperCase())} />
                          </td>
                          <td>
                            <input className="input num w-20" placeholder="MZA1"
                              list={r.scope.wh && r.scope.zone ? `racks-${r.scope.wh}-${r.scope.zone}` : undefined}
                              value={r.scope.rack_zone ?? ""}
                              onChange={(e) => setScope(i, "rack_zone", e.target.value.toUpperCase())} />
                          </td>
                          <td><input className="input num w-16" placeholder="01" value={r.scope.aisle ?? ""}
                            onChange={(e) => setScope(i, "aisle", e.target.value.toUpperCase())} /></td>
                          <td><input className="input num w-16" placeholder="01" value={r.scope.bay ?? ""}
                            onChange={(e) => setScope(i, "bay", e.target.value.toUpperCase())} /></td>
                          <td><input className="input num w-16" placeholder="L1" list="capacity-levels" value={r.scope.level ?? ""}
                            onChange={(e) => setScope(i, "level", e.target.value.toUpperCase())} /></td>
                          <td><input className="input num w-16" placeholder="01" value={r.scope.bin ?? ""}
                            onChange={(e) => setScope(i, "bin", e.target.value.toUpperCase())} /></td>
                          <td>
                            <select className="input w-40" value={r.scope.storage ?? ""}
                              onChange={(e) => setScope(i, "storage", e.target.value)}>
                              <option value="">—</option>
                              {(capMeta?.storages ?? []).map((s) => <option key={s}>{s}</option>)}
                            </select>
                          </td>
                          <td>
                            <select className="input w-44" value={r.scope.l1_category ?? ""}
                              onChange={(e) => setScope(i, "l1_category", e.target.value)}>
                              <option value="">—</option>
                              {(capMeta?.categories ?? []).map((c) => <option key={c}>{c}</option>)}
                            </select>
                          </td>
                          <td>
                            <select className="input w-20" disabled={catScoped}
                              value={r.set.basis ?? ""}
                              onChange={(e) => {
                                const set = { ...r.set };
                                if (e.target.value === "") delete set.basis;
                                else set.basis = e.target.value as "qty" | "cbm";
                                setCapRule(i, { set });
                              }}>
                              <option value="">—</option>
                              <option value="qty">Qty</option>
                              <option value="cbm">CBM</option>
                            </select>
                          </td>
                          <td><input type="number" min={0} step="any" inputMode="decimal"
                            className="input num w-20" disabled={catScoped}
                            value={r.set.max_qty ?? ""} placeholder="—"
                            onChange={(e) => setSetNum(i, "max_qty", e.target.value)} /></td>
                          <td>
                            <input type="number" min={0} step="any" inputMode="decimal"
                              className="input num w-24" disabled={catScoped}
                              value={r.set.max_cbm ?? ""} placeholder="—"
                              title={r.set.max_cbm === undefined ? undefined : `${t("set.ui.capacity.effectivePreview")} ${fmtCapCbm(r.set.max_cbm * (r.set.utilization_pct ?? capacity.utilization_pct) / 100)} m³`}
                              onChange={(e) => setSetNum(i, "max_cbm", e.target.value)} />
                          </td>
                          <td><input type="number" className="input num w-16" disabled={catScoped}
                            value={r.set.utilization_pct ?? ""} placeholder="—"
                            onChange={(e) => setSetNum(i, "utilization_pct", e.target.value)} /></td>
                          <td>
                            <select className="input w-16" disabled={!catScoped}
                              value={r.set.count === undefined ? "" : r.set.count ? "ya" : "tidak"}
                              onChange={(e) => {
                                const set = { ...r.set };
                                if (e.target.value === "") delete set.count;
                                else set.count = e.target.value === "ya";
                                setCapRule(i, { set });
                              }}>
                              <option value="">—</option>
                              <option value="ya">{t("set.ui.yes")}</option>
                              <option value="tidak">{t("set.ui.no")}</option>
                            </select>
                          </td>
                          <td><input className="input w-40" value={r.note}
                            onChange={(e) => setCapRule(i, { note: e.target.value })} /></td>
                          <td>
                            <button className="btn btn-ghost btn-sm" aria-label={t("set.ui.capacity.removeRule")}
                              onClick={() => setCapacity({
                                ...capacity, rules: capacity.rules.filter((_, j) => j !== i),
                              })}>✕</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {/* Add sits below the table: new rules append to the end, so the
                  control has to be where the admin already is. */}
              <button type="button" className="rules-add" onClick={addCapRule}>
                <span aria-hidden>+</span> {t("set.ui.capacity.addRule")}
              </button>
              {(capMeta?.warehouses ?? []).map((w) => (
                <datalist key={w} id={`zones-${w}`}>
                  {(capMeta?.zones[w] ?? []).map((z) => <option key={z} value={z} />)}
                </datalist>
              ))}
              <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                {t("set.ui.capacity.orderHint")}{" "}
                {t("set.ui.capacity.examplePrefix")} <b>MZA1</b> {t("set.ui.capacity.exampleMiddle")}{" "}
                <b>MZA2</b> {t("set.ui.capacity.exampleRack")} <b>SRA1 L1</b>{" "}
                {t("set.ui.capacity.exampleLevel")} <b>{t("set.ui.column.count")}</b>.
              </p>
            </div>
          </div>

          {/* Zone scope. Full width on purpose: this decides which zones exist
              for every occupancy figure, and the chips need room to be read at
              a glance rather than hunted through a nested scroller. */}
          <section className="card card-pad zone-scope">
            <header className="zone-scope-head">
              <div className="zone-scope-intro">
                <div className="panel-title">{t("set.ui.capacity.zonesTitle")}</div>
                <p>{t("set.ui.capacity.zonesHint")}</p>
              </div>
              <div className="zone-scope-status">
                <span className={`chip num${disabledZones.length ? " zone-scope-count-off" : ""}`}>
                  {disabledZones.length
                    ? `${disabledZones.length} ${t("set.ui.capacity.zonesDisabledCount")}`
                    : t("set.ui.capacity.zonesAllActive")}
                </span>
                <div className="zone-scope-legend">
                  <span><i className="zone-dot-on" aria-hidden />{t("set.ui.capacity.legendOn")}</span>
                  <span><i className="zone-dot-off" aria-hidden />{t("set.ui.capacity.legendOff")}</span>
                  <span><i className="zone-dot-orphan" aria-hidden />{t("set.ui.capacity.legendOrphan")}</span>
                </div>
              </div>
            </header>

            {(capMeta?.warehouses ?? []).length === 0 ? (
              <p className="zone-scope-empty">{t("set.ui.capacity.zonesEmpty")}</p>
            ) : (
              <div className="zone-scope-list">
                {(capMeta?.warehouses ?? []).map((wh) => {
                  const zones = zonesFor(wh);
                  const offCount = zones.filter((z) => isZoneOff(wh, z.zone)).length;
                  return (
                    <div key={wh} className="zone-scope-row">
                      <div className="zone-scope-wh">
                        <strong className="num">{wh}</strong>
                        {zones.length > 0 && (
                          <span className="num">
                            {zones.length - offCount} {t("set.ui.capacity.zonesActiveOf")} {zones.length}
                          </span>
                        )}
                        {offCount > 0 && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm zone-scope-reset"
                            onClick={() => capacity && setCapacity({
                              ...capacity,
                              disabled_zones: disabledZones.filter((entry) => entry.wh !== wh),
                            })}
                          >
                            {t("set.ui.capacity.zonesEnableAll")}
                          </button>
                        )}
                      </div>
                      {zones.length === 0 ? (
                        <p className="zone-scope-none">{t("set.ui.capacity.zonesNoneForWh")}</p>
                      ) : (
                        <div className="zone-scope-chips">
                          {zones.map(({ zone, orphan }) => {
                            const off = isZoneOff(wh, zone);
                            return (
                              <button
                                key={zone}
                                type="button"
                                role="switch"
                                aria-checked={!off}
                                aria-label={`${wh} ${zone} — ${off
                                  ? t("set.ui.capacity.legendOff")
                                  : t("set.ui.capacity.legendOn")}`}
                                onClick={() => toggleZone(wh, zone)}
                                title={orphan
                                  ? t("set.ui.capacity.zonesOrphan")
                                  : off
                                    ? t("set.ui.capacity.zoneEnable")
                                    : t("set.ui.capacity.zoneDisable")}
                                className={`zone-chip${off ? " is-off" : ""}${orphan ? " is-orphan" : ""}`}
                              >
                                <i aria-hidden />
                                <span className="num">{zone}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <button className="btn btn-primary" disabled={busy}
            onClick={() => save("capacity", capacity)}>
            {t("set.ui.capacity.save")}
          </button>
        </div>
      )}

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
