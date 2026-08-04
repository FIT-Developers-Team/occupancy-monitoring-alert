"use client";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useT } from "@/lib/i18n-client";

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

interface Thresholds {
  default: { monitor: number; warning: number; critical: number; breach: number; hysteresis_buffer: number };
  overrides: Record<string, Partial<{ monitor: number; warning: number; critical: number; breach: number; hysteresis_buffer: number }>>;
}
interface CapRule {
  scope: {
    wh?: string; zone?: string; rack_zone?: string; aisle?: string; bay?: string;
    level?: string; bin?: string; storage?: string; l1_category?: string;
  };
  set: { basis?: "qty" | "cbm"; max_qty?: number; max_cbm?: number; utilization_pct?: number; count?: boolean };
  note: string;
}
interface Capacity {
  basis_default: "qty" | "cbm";
  utilization_pct: number;
  count_statuses: string[];
  exclude_categories: string[];
  rules: CapRule[];
}
interface CapMeta {
  warehouses: string[]; zones: Record<string, string[]>;
  rack_zones: Record<string, string[]>; levels: string[];
  storages: string[]; categories: string[]; statuses: string[];
}

const TKEYS = ["monitor", "warning", "critical", "breach", "hysteresis_buffer"] as const;

export default function SettingsTabs() {
  const { t } = useT();
  const [tab, setTab] = useState<"sync" | "thresholds" | "capacity" | "recipients">("sync");
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
    { id: "sync" as const, label: t("set.ui.tab.sync", "Superset Sync") },
    { id: "thresholds" as const, label: t("set.ui.tab.thresholds") },
    { id: "capacity" as const, label: t("set.ui.tab.capacity") },
    { id: "recipients" as const, label: t("set.ui.tab.recipients") },
  ];

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

      {tab === "sync" && <SupersetSyncSettings />}

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
              <label className="block space-y-1">
                <span className="eyebrow">{t("set.ui.capacity.volumeUtilisation")}</span>
                <input type="number" min={10} max={100} className="input num w-24"
                  value={capacity.utilization_pct}
                  onChange={(e) => setCapacity({ ...capacity, utilization_pct: Number(e.target.value) })} />
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
                      <input type="number" min={0.001} step={key === "max_cbm" ? "0.001" : "1"}
                        className="input num w-full" placeholder={t("set.ui.capacity.supersetData")}
                        value={global?.set[key] ?? ""}
                        onChange={(e) => setGlobalCapacity(key, e.target.value)} />
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
                          <td><input type="number" className="input num w-20" disabled={catScoped}
                            value={r.set.max_qty ?? ""} placeholder="—"
                            onChange={(e) => setSetNum(i, "max_qty", e.target.value)} /></td>
                          <td><input type="number" step="0.1" className="input num w-20" disabled={catScoped}
                            value={r.set.max_cbm ?? ""} placeholder="—"
                            onChange={(e) => setSetNum(i, "max_cbm", e.target.value)} /></td>
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
          <button className="btn btn-primary" disabled={busy}
            onClick={() => save("thresholds", thresholds)}>
            {t("set.ui.threshold.save")}
          </button>
        </div>
      )}

    </div>
  );
}
