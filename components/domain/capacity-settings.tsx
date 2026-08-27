"use client";
// Editor kapasitas Qty/CBM.
//
// APA YANG BERUBAH DAN KENAPA
// ---------------------------
// Versi sebelumnya menyajikan setiap aturan sebagai satu baris di dalam tabel
// selebar 1430px dengan enam belas kolom masukan mentah. Dengan 57 aturan —
// jumlah yang dipakai instalasi ini — layar itu punya empat masalah yang
// semuanya berujung pada angka okupansi yang salah tanpa ada yang menyadarinya:
//
//   1. Tidak ada satu pun umpan balik. Aturan dengan zona salah ketik terlihat
//      identik dengan aturan yang mengatur belasan ribu lokasi. Sekarang setiap
//      aturan menyebutkan berapa lokasi yang cocok dan berapa yang benar-benar
//      memakai nilainya (/api/capacity/impact).
//   2. Tidak ada cara menemukan sesuatu. Tidak ada pencarian, penyaring, atau
//      pengelompokan pada 57 baris yang harus digulir mendatar. Sekarang ada
//      pencarian, penyaring per gudang/jenis, dan penyaring "hanya yang
//      bermasalah".
//   3. Menambah puluhan aturan berarti mengetiknya satu per satu. Sekarang ada
//      penerapan massal (satu nilai untuk banyak level/zona sekaligus) dan
//      tempel dari spreadsheet dengan pratinjau perubahan.
//   4. Perubahan yang belum disimpan tidak ditandai dan tidak dapat
//      dibatalkan, dan galat validasi dari server dibuang begitu saja sehingga
//      "gagal menyimpan" tidak pernah menyebut baris mana yang salah. Keduanya
//      sekarang ditangani.
//
// Layar ini mengatur PENYEBUT rasio okupansi — berapa yang muat di sebuah
// lokasi. PEMBILANG-nya, yaitu berapa volume yang dimakan satu unit sebuah SKU,
// diatur di tab Standar SKU (components/domain/sku-standard-settings.tsx).
import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n-client";
import NumberField from "@/components/ui/number-field";
import { formatters } from "@/lib/utils";

export type Basis = "qty" | "cbm";

export interface CapScope {
  wh?: string; zone?: string; rack_zone?: string; aisle?: string; bay?: string;
  level?: string; bin?: string; storage?: string; l1_category?: string;
}
export interface CapSet {
  basis?: Basis; max_qty?: number; max_cbm?: number; utilization_pct?: number; count?: boolean;
}
export interface CapRule { scope: CapScope; set: CapSet; note: string }
export interface DisabledZone { wh: string; zone: string; note: string }
export interface Capacity {
  basis_default: Basis;
  utilization_pct: number;
  count_statuses: string[];
  exclude_categories: string[];
  disabled_zones: DisabledZone[];
  rules: CapRule[];
}
export interface CapMeta {
  warehouses: string[];
  zones: Record<string, string[]>;
  rack_zones: Record<string, string[]>;
  levels: string[];
  storages: string[];
  categories: string[];
  statuses: string[];
}

interface RuleImpact { index: number; matched: number; governing: number; passive: boolean }
/** Kolom scope yang dapat diisi, berurut dari yang paling luas ke paling sempit. */
const SCOPE_FIELDS = [
  { key: "wh", labelKey: "set.ui.column.warehouse" },
  { key: "zone", labelKey: "set.ui.column.zone" },
  { key: "rack_zone", labelKey: "set.ui.column.rack" },
  { key: "aisle", labelKey: "set.ui.column.aisle" },
  { key: "bay", labelKey: "set.ui.column.bay" },
  { key: "level", labelKey: "set.ui.column.level" },
  { key: "bin", labelKey: "set.ui.column.bin" },
  { key: "storage", labelKey: "set.ui.column.storage" },
] as const;

type RuleKind = "global" | "location" | "category";

function ruleKind(rule: CapRule): RuleKind {
  if (rule.scope.l1_category) return "category";
  return Object.keys(rule.scope).length ? "location" : "global";
}

/** Kunci identitas scope — dua aturan dengan kunci sama saling menimpa. */
function scopeKey(scope: CapScope): string {
  return Object.entries(scope)
    .filter(([, value]) => value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value).toUpperCase()}`)
    .join("&") || "*";
}

function emptyRule(): CapRule {
  return { scope: {}, set: {}, note: "" };
}

/** Nilai numerik dari sebuah input; string kosong berarti "tidak diatur". */
function numberOrUndefined(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Angka dari sel spreadsheet, dengan koma desimal.
 *
 * `Number("0,0658")` adalah NaN, dan itulah bentuk yang keluar dari setiap
 * spreadsheet berbahasa Indonesia. Tanpa penanganan ini, menempel kapasitas
 * CBM dari Excel akan melewati SETIAP baris tanpa satu pun tanda mengapa.
 */
function spreadsheetNumber(raw: string): number | undefined {
  // `\s` sudah mencakup spasi tanpa-pemutus, bentuk yang dipakai sebagian
  // locale Excel sebagai pemisah ribuan.
  const trimmed = (raw ?? "").replace(/\s/g, "");
  if (!trimmed) return undefined;
  const hasComma = trimmed.includes(",");
  const hasDot = trimmed.includes(".");
  // Keduanya ada: titik adalah pemisah ribuan (1.234,5), koma desimalnya.
  const normalized = hasComma && hasDot
    ? trimmed.replaceAll(".", "").replace(",", ".")
    : hasComma
      ? trimmed.replace(",", ".")
      : trimmed;
  return numberOrUndefined(normalized);
}

let ruleIdSeed = 0;
const nextRuleId = () => `r${(ruleIdSeed += 1)}`;

export default function CapacitySettings() {
  const { t, lang } = useT();
  const f = formatters(lang);

  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [meta, setMeta] = useState<CapMeta | null>(null);
  const [baseline, setBaseline] = useState<string>("");
  const [ids, setIds] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [impact, setImpact] = useState<Record<number, RuleImpact>>({});
  const [impactState, setImpactState] = useState<"idle" | "loading" | "stale" | "ready">("idle");

  const [query, setQuery] = useState("");
  const [filterWh, setFilterWh] = useState("");
  const [filterKind, setFilterKind] = useState<"all" | RuleKind>("all");
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [tool, setTool] = useState<"none" | "bulk" | "paste">("none");

  // ---- muat -----------------------------------------------------------------
  useEffect(() => {
    let active = true;
    (async () => {
      const response = await fetch("/api/config/capacity", { cache: "no-store" });
      const body = await response.json();
      if (!active) return;
      const data = body.data as Capacity | null;
      if (!data) throw new Error("empty");
      setCapacity(data);
      setMeta(body.meta ?? null);
      setBaseline(JSON.stringify(data));
      setIds(data.rules.map(() => nextRuleId()));
    })().catch(() => setMessage({ tone: "error", text: t("set.ui.loadError") }));
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = capacity !== null && JSON.stringify(capacity) !== baseline;

  // Menutup tab dengan perubahan yang belum disimpan adalah cara paling sunyi
  // kehilangan setengah jam penyetelan. Peringatan bawaan browser sudah cukup.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // ---- pratinjau dampak -----------------------------------------------------
  const rulesSignature = capacity ? JSON.stringify(capacity.rules) : "";
  const refreshImpact = useCallback(async (rules: CapRule[]) => {
    setImpactState("loading");
    try {
      const response = await fetch("/api/capacity/impact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules }),
      });
      const body = await response.json();
      const next: Record<number, RuleImpact> = {};
      for (const entry of (body.impact ?? []) as RuleImpact[]) next[entry.index] = entry;
      setImpact(next);
      setImpactState(Object.keys(next).length ? "ready" : "idle");
    } catch {
      setImpactState("idle");
    }
  }, []);

  useEffect(() => {
    if (!capacity) return;
    setImpactState("stale");
    const rules = capacity.rules;
    // Menunggu jeda mengetik: satu kueri per penekanan tombol pada 57 aturan
    // akan memindai data master berkali-kali tanpa memberi informasi baru.
    const timer = window.setTimeout(() => { void refreshImpact(rules); }, 800);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rulesSignature]);

  // ---- mutasi ---------------------------------------------------------------
  const update = useCallback((next: Capacity, nextIds?: string[]) => {
    setCapacity(next);
    if (nextIds) setIds(nextIds);
    setMessage(null);
  }, []);

  const patchRule = (index: number, patch: Partial<CapRule>) => {
    if (!capacity) return;
    const rules = [...capacity.rules];
    rules[index] = { ...rules[index], ...patch };
    update({ ...capacity, rules });
  };

  const setScope = (index: number, key: keyof CapScope, value: string) => {
    if (!capacity) return;
    const scope = { ...capacity.rules[index].scope };
    if (value.trim() === "") delete scope[key];
    else scope[key] = value.trim();
    patchRule(index, { scope });
  };

  const setValue = (index: number, key: "max_qty" | "max_cbm" | "utilization_pct", raw: string) => {
    if (!capacity) return;
    const set = { ...capacity.rules[index].set };
    const value = numberOrUndefined(raw);
    if (value === undefined) delete set[key];
    else set[key] = value;
    patchRule(index, { set });
  };

  const addRules = (newRules: CapRule[], expandFirst = true) => {
    if (!capacity || !newRules.length) return;
    const newIds = newRules.map(() => nextRuleId());
    update({ ...capacity, rules: [...capacity.rules, ...newRules] }, [...ids, ...newIds]);
    if (expandFirst) setExpanded(new Set([...expanded, newIds[0]]));
    window.setTimeout(() => {
      document.getElementById(`cap-rule-${newIds[0]}`)?.scrollIntoView({ block: "center" });
    }, 0);
  };

  const removeRule = (index: number) => {
    if (!capacity) return;
    update(
      { ...capacity, rules: capacity.rules.filter((_, i) => i !== index) },
      ids.filter((_, i) => i !== index),
    );
  };

  const duplicateRule = (index: number) => {
    if (!capacity) return;
    const copy: CapRule = JSON.parse(JSON.stringify(capacity.rules[index]));
    const rules = [...capacity.rules];
    const nextIds = [...ids];
    const id = nextRuleId();
    rules.splice(index + 1, 0, copy);
    nextIds.splice(index + 1, 0, id);
    update({ ...capacity, rules }, nextIds);
    setExpanded(new Set([...expanded, id]));
  };

  const moveRule = (index: number, delta: number) => {
    if (!capacity) return;
    const target = index + delta;
    if (target < 0 || target >= capacity.rules.length) return;
    const rules = [...capacity.rules];
    const nextIds = [...ids];
    [rules[index], rules[target]] = [rules[target], rules[index]];
    [nextIds[index], nextIds[target]] = [nextIds[target], nextIds[index]];
    update({ ...capacity, rules }, nextIds);
  };

  /**
   * Override global adalah aturan tanpa scope. Ia disimpan sebagai aturan biasa
   * supaya urutan menangnya tetap satu aturan yang sama dengan sisanya, dan
   * selalu diletakkan paling atas agar override gudang/zona di bawahnya tetap
   * lebih spesifik.
   */
  const globalIndex = capacity?.rules.findIndex((rule) => Object.keys(rule.scope).length === 0) ?? -1;
  const globalRule = globalIndex >= 0 ? capacity!.rules[globalIndex] : undefined;

  const setGlobal = (key: "max_qty" | "max_cbm", raw: string) => {
    if (!capacity) return;
    const value = numberOrUndefined(raw);
    if (globalIndex < 0) {
      if (value === undefined) return;
      const rule: CapRule = { scope: {}, set: { [key]: value }, note: t("set.ui.capacity.globalOverrideNote") };
      update({ ...capacity, rules: [rule, ...capacity.rules] }, [nextRuleId(), ...ids]);
      return;
    }
    const rules = [...capacity.rules];
    const set = { ...rules[globalIndex].set };
    if (value === undefined) delete set[key];
    else set[key] = value;
    rules[globalIndex] = { ...rules[globalIndex], set };
    update({ ...capacity, rules });
  };

  const toggleList = (list: string[], value: string) =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  // ---- simpan ---------------------------------------------------------------
  async function save() {
    if (!capacity) return;
    setBusy(true);
    setMessage(null);
    setIssues({});
    try {
      const response = await fetch("/api/config/capacity", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(capacity),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const found: Record<string, string> = {};
        for (const issue of (body.issues ?? []) as Array<{ path: string[]; message: string }>) {
          if (issue.path[0] === "rules" && issue.path[1] !== undefined) {
            found[issue.path[1]] = issue.message;
          }
        }
        setIssues(found);
        setMessage({ tone: "error", text: body.error || t("set.ui.saveError") });
        return;
      }
      // Skema membuang aturan kosong dan merapikan scope saat menyimpan, jadi
      // yang ditampilkan sesudahnya adalah apa yang benar-benar tersimpan —
      // bukan apa yang sempat diketik.
      const saved = body.data as Capacity;
      setCapacity(saved);
      setBaseline(JSON.stringify(saved));
      setIds(saved.rules.map(() => nextRuleId()));
      const dropped = capacity.rules.length - saved.rules.length;
      setMessage({
        tone: "ok",
        text: dropped > 0
          ? `${t("set.ui.saved")} ${t("set.ui.capacity.droppedEmpty").replace("{n}", String(dropped))}`
          : t("set.ui.saved"),
      });
    } catch (error) {
      setMessage({ tone: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function revert() {
    if (!baseline) return;
    const restored = JSON.parse(baseline) as Capacity;
    setCapacity(restored);
    setIds(restored.rules.map(() => nextRuleId()));
    setIssues({});
    setMessage(null);
  }

  // ---- turunan untuk daftar aturan ------------------------------------------
  const duplicates = useMemo(() => {
    const counts = new Map<string, number[]>();
    for (const [index, rule] of (capacity?.rules ?? []).entries()) {
      const key = scopeKey(rule.scope);
      counts.set(key, [...(counts.get(key) ?? []), index]);
    }
    return counts;
  }, [capacity?.rules]);

  const visibleRules = useMemo(() => {
    if (!capacity) return [] as Array<{ rule: CapRule; index: number }>;
    const needle = query.trim().toLowerCase();
    return capacity.rules
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule, index }) => {
        if (filterWh && rule.scope.wh !== filterWh) return false;
        if (filterKind !== "all" && ruleKind(rule) !== filterKind) return false;
        if (onlyProblems) {
          const info = impact[index];
          const scored = info && !info.passive && ruleKind(rule) !== "category";
          const shadowed = scored && info.matched > 0 && info.governing === 0;
          const dead = scored && info.matched === 0;
          const duplicated = (duplicates.get(scopeKey(rule.scope)) ?? []).length > 1;
          if (!shadowed && !dead && !duplicated && !issues[String(index)]) return false;
        }
        if (!needle) return true;
        const haystack = [
          ...Object.values(rule.scope),
          rule.note,
          rule.set.basis,
          rule.set.max_qty, rule.set.max_cbm, rule.set.utilization_pct,
        ].filter(Boolean).join(" ").toLowerCase();
        return haystack.includes(needle);
      });
  }, [capacity, query, filterWh, filterKind, onlyProblems, impact, duplicates, issues]);

  const stats = useMemo(() => {
    const rules = capacity?.rules ?? [];
    let dead = 0;
    let shadowed = 0;
    for (const [index, rule] of rules.entries()) {
      const info = impact[index];
      if (!info || info.passive || ruleKind(rule) === "category") continue;
      if (info.matched === 0) dead += 1;
      else if (info.governing === 0) shadowed += 1;
    }
    return {
      total: rules.length,
      category: rules.filter((rule) => ruleKind(rule) === "category").length,
      dead,
      shadowed,
    };
  }, [capacity?.rules, impact]);

  if (!capacity) {
    return (
      <div className="settings-panel-loading" role="status" aria-live="polite">
        <div className="settings-panel-loading-head"><span /><strong /></div>
        <div className="settings-panel-loading-grid"><span /><span /></div>
        <span className="sr-only">{t("set.ui.capacity.loading")}</span>
      </div>
    );
  }

  const warehouses = meta?.warehouses ?? [];
  const disabledZones = capacity.disabled_zones ?? [];
  const isZoneOff = (wh: string, zone: string) =>
    disabledZones.some((entry) => entry.wh === wh && entry.zone === zone);
  const toggleZone = (wh: string, zone: string) => {
    update({
      ...capacity,
      disabled_zones: isZoneOff(wh, zone)
        ? disabledZones.filter((entry) => !(entry.wh === wh && entry.zone === zone))
        : [...disabledZones, { wh, zone, note: "" }],
    });
  };
  const zonesFor = (wh: string): Array<{ zone: string; orphan: boolean }> => {
    const known = meta?.zones?.[wh] ?? [];
    const orphans = disabledZones
      .filter((entry) => entry.wh === wh && !known.includes(entry.zone))
      .map((entry) => entry.zone);
    return [
      ...known.map((zone) => ({ zone, orphan: false })),
      ...orphans.map((zone) => ({ zone, orphan: true })),
    ];
  };

  return (
    <div className="cap-settings">
      {/* Saran isian diambil dari data master yang sama dengan yang dipakai
          okupansi, sehingga nilai yang ditawarkan pasti dapat dicocokkan. */}
      <datalist id="cap-levels">
        {(meta?.levels ?? []).map((level) => <option key={level} value={level} />)}
      </datalist>
      {Object.entries(meta?.zones ?? {}).map(([wh, zones]) => (
        <datalist key={wh} id={`cap-zones-${wh}`}>
          {zones.map((zone) => <option key={zone} value={zone} />)}
        </datalist>
      ))}
      {Object.entries(meta?.rack_zones ?? {}).map(([key, racks]) => (
        <datalist key={key} id={`cap-racks-${key.replace("|", "-")}`}>
          {racks.map((rack) => <option key={rack} value={rack} />)}
        </datalist>
      ))}

      {message && (
        <p className={`settings-message${message.tone === "error" ? " is-error" : ""}`} role="status">
          {message.text}
        </p>
      )}

      <div className="cap-columns">
        {/* ---------- kebijakan dasar ---------- */}
        <section className="card card-pad cap-base">
          <div className="panel-title">{t("set.ui.capacity.adminTitle")}</div>
          <p className="cap-hint">
            {t("set.ui.capacity.defaultPrefix")} <span className="num">max_quantity</span> &amp;{" "}
            <span className="num">max_volume</span> {t("set.ui.capacity.defaultSuffix")}
          </p>

          <div className="capacity-warehouse-scope">
            <span className="eyebrow">{t("set.ui.capacity.availableWarehouses")}</span>
            <div>
              {warehouses.map((warehouse) => (
                <span key={warehouse} className="chip num">{warehouse}</span>
              ))}
            </div>
          </div>

          <label className="block space-y-1">
            <span className="eyebrow">{t("set.ui.capacity.basis")}</span>
            <select
              className="input"
              value={capacity.basis_default}
              onChange={(event) => update({ ...capacity, basis_default: event.target.value as Basis })}
            >
              <option value="qty">{t("set.ui.capacity.qtyOption")}</option>
              <option value="cbm">{t("set.ui.capacity.cbmOption")}</option>
            </select>
          </label>

          <label className="block space-y-1">
            <span className="eyebrow">{t("set.ui.capacity.volumeUtilisation")}</span>
            <NumberField
              min={10} max={100} step={1} className="input num w-24"
              value={capacity.utilization_pct}
              onChange={(utilization_pct) => update({ ...capacity, utilization_pct })}
            />
            <span className="field-hint">{t("set.ui.capacity.utilisationHint")}</span>
          </label>

          <div className="grid grid-cols-2 gap-2">
            {(["max_qty", "max_cbm"] as const).map((key) => (
              <label key={key} className="block space-y-1">
                <span className="eyebrow">
                  {key === "max_qty"
                    ? t("set.ui.capacity.globalQtyOverride")
                    : t("set.ui.capacity.globalCbmOverride")}
                </span>
                {/* step="0.001" menolak nilai seperti 0,0336 di sebagian
                    browser (stepMismatch). Kapasitas per-slot memang serapat
                    itu, jadi langkahnya dibebaskan. */}
                <input
                  type="number" min={0} step="any" inputMode="decimal"
                  className="input num w-full" placeholder={t("set.ui.capacity.supersetData")}
                  value={globalRule?.set[key] ?? ""}
                  onChange={(event) => setGlobal(key, event.target.value)}
                />
                {key === "max_cbm" && globalRule?.set.max_cbm !== undefined && (
                  <span className="field-hint num">
                    {t("set.ui.capacity.effectivePreview")}{" "}
                    {f.capCbm(globalRule.set.max_cbm * capacity.utilization_pct / 100)} m³
                  </span>
                )}
              </label>
            ))}
          </div>
          <p className="cap-hint">
            {t("set.ui.capacity.emptyPrefix")} <span className="num">max_quantity</span> /{" "}
            <span className="num">max_volume</span> {t("set.ui.capacity.emptySuffix")}
          </p>

          <div className="space-y-1">
            <span className="eyebrow">{t("set.ui.capacity.countedStatuses")}</span>
            <div className="flex flex-wrap gap-2">
              {(meta?.statuses ?? ["Available", "Bad", "Lost"]).map((status) => (
                <label key={status} className="chip cursor-pointer gap-1.5">
                  <input
                    type="checkbox"
                    checked={capacity.count_statuses.includes(status)}
                    onChange={() => update({
                      ...capacity, count_statuses: toggleList(capacity.count_statuses, status),
                    })}
                  />
                  {t(`set.ui.stockStatus.${status}`, status)}
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <span className="eyebrow">{t("set.ui.capacity.excludedCategories")}</span>
            <div className="cap-category-list">
              {(meta?.categories ?? capacity.exclude_categories).map((category) => (
                <label key={category} className="flex items-center gap-2 text-[11.5px]">
                  <input
                    type="checkbox"
                    checked={capacity.exclude_categories.includes(category)}
                    onChange={() => update({
                      ...capacity, exclude_categories: toggleList(capacity.exclude_categories, category),
                    })}
                  />
                  <span className="truncate">{category}</span>
                </label>
              ))}
            </div>
          </div>
        </section>

        {/* ---------- aturan ---------- */}
        <section className="cap-rules">
          <header className="cap-rules-head">
            <div className="min-w-0">
              <div className="panel-title">{t("set.ui.capacity.overrideRules")}</div>
              <p className="cap-hint">{t("set.ui.capacity.overrideHint")}</p>
            </div>
            <div className="cap-rules-stats">
              <span className="chip num" title={t("set.ui.capacity.statTotal")}>
                {stats.total} {t("set.ui.capacity.statRules")}
              </span>
              {stats.dead > 0 && (
                <span className="chip num cap-chip-warn" title={t("set.ui.capacity.deadHint")}>
                  {stats.dead} {t("set.ui.capacity.statDead")}
                </span>
              )}
              {stats.shadowed > 0 && (
                <span className="chip num cap-chip-warn" title={t("set.ui.capacity.shadowHint")}>
                  {stats.shadowed} {t("set.ui.capacity.statShadowed")}
                </span>
              )}
            </div>
          </header>

          <div className="cap-toolbar">
            <input
              type="search"
              className="input cap-search"
              placeholder={t("set.ui.capacity.searchPlaceholder")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t("set.ui.capacity.searchPlaceholder")}
            />
            <select
              className="input w-28" value={filterWh}
              onChange={(event) => setFilterWh(event.target.value)}
              aria-label={t("set.ui.column.warehouse")}
            >
              <option value="">{t("set.ui.capacity.allWarehouses")}</option>
              {warehouses.map((warehouse) => <option key={warehouse}>{warehouse}</option>)}
            </select>
            <select
              className="input w-36" value={filterKind}
              onChange={(event) => setFilterKind(event.target.value as "all" | RuleKind)}
              aria-label={t("set.ui.capacity.kindFilter")}
            >
              <option value="all">{t("set.ui.capacity.kindAll")}</option>
              <option value="global">{t("set.ui.capacity.kindGlobal")}</option>
              <option value="location">{t("set.ui.capacity.kindLocation")}</option>
              <option value="category">{t("set.ui.capacity.kindCategory")}</option>
            </select>
            <label className="chip cursor-pointer gap-1.5">
              <input
                type="checkbox" checked={onlyProblems}
                onChange={(event) => setOnlyProblems(event.target.checked)}
              />
              {t("set.ui.capacity.onlyProblems")}
            </label>
            <span className={`cap-impact-state is-${impactState}`}>
              {impactState === "loading" || impactState === "stale"
                ? t("set.ui.capacity.impactChecking")
                : impactState === "ready"
                  ? t("set.ui.capacity.impactReady")
                  : ""}
            </span>
          </div>

          {visibleRules.length === 0 ? (
            <p className="cap-empty">
              {capacity.rules.length === 0
                ? t("set.ui.capacity.noRules")
                : t("set.ui.capacity.noMatch")}
            </p>
          ) : (
            <ol className="cap-rule-list">
              {visibleRules.map(({ rule, index }) => (
                <RuleRow
                  key={ids[index] ?? index}
                  id={ids[index] ?? `i${index}`}
                  rule={rule}
                  index={index}
                  total={capacity.rules.length}
                  meta={meta}
                  utilization={capacity.utilization_pct}
                  impact={impact[index]}
                  issue={issues[String(index)]}
                  duplicateOf={(duplicates.get(scopeKey(rule.scope)) ?? []).filter((i) => i !== index)}
                  expanded={expanded.has(ids[index] ?? "")}
                  onToggle={() => {
                    const id = ids[index];
                    const next = new Set(expanded);
                    if (next.has(id)) next.delete(id); else next.add(id);
                    setExpanded(next);
                  }}
                  onScope={(key, value) => setScope(index, key, value)}
                  onSet={(patch) => patchRule(index, { set: { ...rule.set, ...patch } })}
                  onValue={(key, raw) => setValue(index, key, raw)}
                  onNote={(note) => patchRule(index, { note })}
                  onDuplicate={() => duplicateRule(index)}
                  onMove={(delta) => moveRule(index, delta)}
                  onRemove={() => removeRule(index)}
                />
              ))}
            </ol>
          )}

          <div className="cap-add-row">
            <button type="button" className="rules-add" onClick={() => addRules([emptyRule()])}>
              <span aria-hidden>+</span> {t("set.ui.capacity.addRule")}
            </button>
            <button
              type="button"
              className={`btn btn-sm${tool === "bulk" ? " btn-primary" : ""}`}
              onClick={() => setTool(tool === "bulk" ? "none" : "bulk")}
            >
              {t("set.ui.capacity.bulkOpen")}
            </button>
            <button
              type="button"
              className={`btn btn-sm${tool === "paste" ? " btn-primary" : ""}`}
              onClick={() => setTool(tool === "paste" ? "none" : "paste")}
            >
              {t("set.ui.capacity.pasteOpen")}
            </button>
          </div>

          {tool === "bulk" && (
            <BulkApply
              meta={meta}
              utilization={capacity.utilization_pct}
              onApply={(rules) => { addRules(rules, false); setTool("none"); }}
              onClose={() => setTool("none")}
            />
          )}
          {tool === "paste" && (
            <PasteRules
              existing={capacity.rules}
              onApply={(rules, replaced) => {
                const kept = capacity.rules.filter((_, index) => !replaced.has(index));
                const keptIds = ids.filter((_, index) => !replaced.has(index));
                const newIds = rules.map(() => nextRuleId());
                update({ ...capacity, rules: [...kept, ...rules] }, [...keptIds, ...newIds]);
                setTool("none");
              }}
              onClose={() => setTool("none")}
            />
          )}

          <p className="cap-hint">
            {t("set.ui.capacity.orderHint")}{" "}
            {t("set.ui.capacity.examplePrefix")} <b>MZA1</b> {t("set.ui.capacity.exampleMiddle")}{" "}
            <b>MZA2</b> {t("set.ui.capacity.exampleRack")} <b>SRA1 L1</b>{" "}
            {t("set.ui.capacity.exampleLevel")} <b>{t("set.ui.column.count")}</b>.
          </p>
        </section>
      </div>

      {/* ---------- zona ---------- */}
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

        {warehouses.length === 0 ? (
          <p className="zone-scope-empty">{t("set.ui.capacity.zonesEmpty")}</p>
        ) : (
          <div className="zone-scope-list">
            {warehouses.map((wh) => {
              const zones = zonesFor(wh);
              const offCount = zones.filter((zone) => isZoneOff(wh, zone.zone)).length;
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
                        onClick={() => update({
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

      {/* Bilah simpan menempel di DASAR layar, bukan di puncaknya: topbar
          aplikasi sudah `sticky top: 0`, dan dua elemen yang sama-sama menempel
          di atas akan saling menutupi. Panel Eskalasi memakai pola yang sama,
          jadi tombol Simpan berada di tempat yang sama pada kedua layar — dan
          tetap terjangkau tanpa menggulir melewati puluhan aturan. */}
      <div className={`cap-actionbar${dirty ? " is-dirty" : ""}`}>
        <div className="cap-actionbar-status">
          <strong>{t("set.ui.capacity.title")}</strong>
          <span>{dirty ? t("set.ui.capacity.unsaved") : t("set.ui.capacity.allSaved")}</span>
        </div>
        <div className="cap-actionbar-buttons">
          <button type="button" className="btn btn-sm" disabled={!dirty || busy} onClick={revert}>
            {t("set.ui.capacity.revert")}
          </button>
          <button type="button" className="btn btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? t("set.ui.capacity.saving") : t("set.ui.capacity.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Satu aturan: ringkasan yang dapat dibaca sekilas, editor penuh saat dibuka.
// ---------------------------------------------------------------------------

function RuleRow({
  id, rule, index, total, meta, utilization, impact, issue, duplicateOf,
  expanded, onToggle, onScope, onSet, onValue, onNote, onDuplicate, onMove, onRemove,
}: {
  id: string;
  rule: CapRule;
  index: number;
  total: number;
  meta: CapMeta | null;
  utilization: number;
  impact?: RuleImpact;
  issue?: string;
  duplicateOf: number[];
  expanded: boolean;
  onToggle: () => void;
  onScope: (key: keyof CapScope, value: string) => void;
  onSet: (patch: Partial<CapSet>) => void;
  onValue: (key: "max_qty" | "max_cbm" | "utilization_pct", raw: string) => void;
  onNote: (note: string) => void;
  onDuplicate: () => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const { t, lang } = useT();
  const f = formatters(lang);
  const kind = ruleKind(rule);
  const categoryScoped = kind === "category";
  const effectiveUtil = rule.set.utilization_pct ?? utilization;

  const chips = SCOPE_FIELDS
    .map((field) => ({ field, value: rule.scope[field.key] }))
    .filter((entry) => entry.value);

  const dead = impact && !impact.passive && impact.matched === 0;
  const shadowed = impact && !impact.passive && impact.matched > 0 && impact.governing === 0;
  const partiallyShadowed = impact && !impact.passive && impact.governing > 0
    && impact.governing < impact.matched;

  return (
    <li
      id={`cap-rule-${id}`}
      className={`cap-rule${expanded ? " is-open" : ""}${issue ? " is-invalid" : ""}${dead || shadowed ? " is-warned" : ""}`}
    >
      <div className="cap-rule-summary">
        <button
          type="button"
          className="cap-rule-toggle"
          aria-expanded={expanded}
          aria-controls={`cap-rule-body-${id}`}
          onClick={onToggle}
        >
          <span className="cap-rule-index num">{index + 1}</span>
          <span className={`cap-kind cap-kind-${kind}`}>{t(`set.ui.capacity.kind.${kind}`)}</span>
          <span className="cap-rule-scope">
            {chips.length === 0 && !rule.scope.l1_category ? (
              <em>{t("set.ui.capacity.scopeGlobal")}</em>
            ) : (
              <>
                {rule.scope.l1_category && (
                  <span className="cap-scope-chip is-category">{rule.scope.l1_category}</span>
                )}
                {chips.map(({ field, value }) => (
                  <span key={field.key} className="cap-scope-chip num">
                    <i>{t(field.labelKey)}</i>{value}
                  </span>
                ))}
              </>
            )}
          </span>
          <span className="cap-rule-values num">
            {rule.set.basis && <b>{rule.set.basis.toUpperCase()}</b>}
            {rule.set.max_qty !== undefined && (
              <span>{t("set.ui.column.maxQty")} {f.num(rule.set.max_qty)}</span>
            )}
            {rule.set.max_cbm !== undefined && (
              <span title={`${t("set.ui.capacity.effectivePreview")} ${f.capCbm(rule.set.max_cbm * effectiveUtil / 100)} m³`}>
                {t("set.ui.column.maxCbm")} {f.capCbm(rule.set.max_cbm)}
              </span>
            )}
            {rule.set.utilization_pct !== undefined && <span>{rule.set.utilization_pct}%</span>}
            {rule.set.count !== undefined && (
              <span>{t("set.ui.column.count")}: {rule.set.count ? t("set.ui.yes") : t("set.ui.no")}</span>
            )}
          </span>
          <span className="cap-rule-impact">
            {/* Aturan berkategori sengaja tidak diberi lencana: ia dinilai
                terhadap BARIS STOK, bukan lokasi, jadi "N lokasi" akan menjadi
                angka yang benar-benar salah alih-alih sekadar tidak ada. */}
            {impact === undefined || categoryScoped ? null : impact.passive ? (
              <span className="cap-badge">{t("set.ui.capacity.impactPassive")}</span>
            ) : dead ? (
              <span className="cap-badge is-warn" title={t("set.ui.capacity.deadHint")}>
                {t("set.ui.capacity.impactDead")}
              </span>
            ) : shadowed ? (
              <span className="cap-badge is-warn" title={t("set.ui.capacity.shadowHint")}>
                {t("set.ui.capacity.impactShadowed")}
              </span>
            ) : (
              <span
                className="cap-badge num"
                title={partiallyShadowed ? t("set.ui.capacity.partialHint") : t("set.ui.capacity.impactHint")}
              >
                {f.num(impact.governing)}
                {partiallyShadowed && <em>/{f.num(impact.matched)}</em>}
                {" "}{t("set.ui.capacity.impactLocations")}
              </span>
            )}
          </span>
        </button>
        <div className="cap-rule-actions">
          <button type="button" className="btn btn-ghost btn-sm" title={t("set.ui.capacity.moveUp")}
            disabled={index === 0} onClick={() => onMove(-1)} aria-label={t("set.ui.capacity.moveUp")}>↑</button>
          <button type="button" className="btn btn-ghost btn-sm" title={t("set.ui.capacity.moveDown")}
            disabled={index === total - 1} onClick={() => onMove(1)} aria-label={t("set.ui.capacity.moveDown")}>↓</button>
          <button type="button" className="btn btn-ghost btn-sm" title={t("set.ui.capacity.duplicate")}
            onClick={onDuplicate} aria-label={t("set.ui.capacity.duplicate")}>⧉</button>
          <button type="button" className="btn btn-ghost btn-sm" title={t("set.ui.capacity.removeRule")}
            onClick={onRemove} aria-label={t("set.ui.capacity.removeRule")}>✕</button>
        </div>
      </div>

      {(issue || duplicateOf.length > 0) && (
        <div className="cap-rule-flags">
          {issue && <p className="cap-flag is-error">{issue}</p>}
          {duplicateOf.length > 0 && (
            <p className="cap-flag">
              {t("set.ui.capacity.duplicateOf").replace(
                "{n}", duplicateOf.map((i) => `#${i + 1}`).join(", "))}
            </p>
          )}
        </div>
      )}

      {expanded && (
        <div className="cap-rule-body" id={`cap-rule-body-${id}`}>
          <fieldset className="cap-fieldset">
            <legend>{t("set.ui.capacity.scopeLegend")}</legend>
            <div className="cap-grid">
              <label>
                <span className="eyebrow">{t("set.ui.column.warehouse")}</span>
                <select className="input" value={rule.scope.wh ?? ""}
                  onChange={(event) => onScope("wh", event.target.value)}>
                  <option value="">{t("set.ui.capacity.anyValue")}</option>
                  {(meta?.warehouses ?? []).map((warehouse) => <option key={warehouse}>{warehouse}</option>)}
                </select>
              </label>
              <label>
                <span className="eyebrow">{t("set.ui.column.zone")}</span>
                <input className="input num" placeholder="SRA / SRA1"
                  list={rule.scope.wh ? `cap-zones-${rule.scope.wh}` : undefined}
                  value={rule.scope.zone ?? ""}
                  onChange={(event) => onScope("zone", event.target.value.toUpperCase())} />
                <span className="field-hint">{t("set.ui.capacity.zoneFieldHint")}</span>
              </label>
              <label>
                <span className="eyebrow">{t("set.ui.column.rack")}</span>
                <input className="input num" placeholder="MZA1"
                  list={rule.scope.wh && rule.scope.zone
                    ? `cap-racks-${rule.scope.wh}-${rule.scope.zone}` : undefined}
                  value={rule.scope.rack_zone ?? ""}
                  onChange={(event) => onScope("rack_zone", event.target.value.toUpperCase())} />
              </label>
              <label>
                <span className="eyebrow">{t("set.ui.column.aisle")}</span>
                <input className="input num" placeholder="01" value={rule.scope.aisle ?? ""}
                  onChange={(event) => onScope("aisle", event.target.value.toUpperCase())} />
              </label>
              <label>
                <span className="eyebrow">{t("set.ui.column.bay")}</span>
                <input className="input num" placeholder="01" value={rule.scope.bay ?? ""}
                  onChange={(event) => onScope("bay", event.target.value.toUpperCase())} />
              </label>
              <label>
                <span className="eyebrow">{t("set.ui.column.level")}</span>
                {/* Placeholder-nya dulu "L1", padahal data master menyimpan "1".
                    Satu petunjuk yang salah di sini menghasilkan aturan yang
                    tidak pernah cocok dengan apa pun. */}
                <input className="input num" placeholder={(meta?.levels ?? [])[0] ?? "1"}
                  list="cap-levels" value={rule.scope.level ?? ""}
                  onChange={(event) => onScope("level", event.target.value.toUpperCase())} />
              </label>
              <label>
                <span className="eyebrow">{t("set.ui.column.bin")}</span>
                <input className="input num" placeholder="01" value={rule.scope.bin ?? ""}
                  onChange={(event) => onScope("bin", event.target.value.toUpperCase())} />
              </label>
              <label>
                <span className="eyebrow">{t("set.ui.column.storage")}</span>
                <select className="input" value={rule.scope.storage ?? ""}
                  onChange={(event) => onScope("storage", event.target.value)}>
                  <option value="">{t("set.ui.capacity.anyValue")}</option>
                  {(meta?.storages ?? []).map((storage) => <option key={storage}>{storage}</option>)}
                </select>
              </label>
            </div>

            <div className="cap-grid cap-grid-wide">
              <label>
                <span className="eyebrow">{t("set.ui.column.category")}</span>
                <select className="input" value={rule.scope.l1_category ?? ""}
                  onChange={(event) => onScope("l1_category", event.target.value)}>
                  <option value="">{t("set.ui.capacity.anyValue")}</option>
                  {(meta?.categories ?? []).map((category) => <option key={category}>{category}</option>)}
                </select>
                <span className="field-hint">{t("set.ui.capacity.categoryFieldHint")}</span>
              </label>
            </div>
          </fieldset>

          <fieldset className="cap-fieldset">
            <legend>{t("set.ui.capacity.valuesLegend")}</legend>
            <div className="cap-grid">
              <label>
                <span className="eyebrow">{t("set.ui.column.basis")}</span>
                <select className="input" disabled={categoryScoped} value={rule.set.basis ?? ""}
                  onChange={(event) => onSet({
                    basis: event.target.value === "" ? undefined : event.target.value as Basis,
                  })}>
                  <option value="">{t("set.ui.capacity.inherit")}</option>
                  <option value="qty">Qty</option>
                  <option value="cbm">CBM</option>
                </select>
              </label>
              <label>
                <span className="eyebrow">{t("set.ui.column.maxQty")}</span>
                <input type="number" min={0} step="any" inputMode="decimal" className="input num"
                  disabled={categoryScoped} value={rule.set.max_qty ?? ""} placeholder={t("set.ui.capacity.inherit")}
                  onChange={(event) => onValue("max_qty", event.target.value)} />
              </label>
              <label>
                <span className="eyebrow">{t("set.ui.column.maxCbm")}</span>
                <input type="number" min={0} step="any" inputMode="decimal" className="input num"
                  disabled={categoryScoped} value={rule.set.max_cbm ?? ""} placeholder={t("set.ui.capacity.inherit")}
                  onChange={(event) => onValue("max_cbm", event.target.value)} />
                {rule.set.max_cbm !== undefined && (
                  <span className="field-hint num">
                    {t("set.ui.capacity.effectivePreview")}{" "}
                    {f.capCbm(rule.set.max_cbm * effectiveUtil / 100)} m³
                  </span>
                )}
              </label>
              <label>
                <span className="eyebrow">{t("set.ui.column.utilisation")}</span>
                <input type="number" min={10} max={100} className="input num"
                  disabled={categoryScoped} value={rule.set.utilization_pct ?? ""}
                  placeholder={String(utilization)}
                  onChange={(event) => onValue("utilization_pct", event.target.value)} />
              </label>
              <label>
                <span className="eyebrow">{t("set.ui.column.count")}</span>
                <select className="input" disabled={!categoryScoped}
                  value={rule.set.count === undefined ? "" : rule.set.count ? "yes" : "no"}
                  onChange={(event) => onSet({
                    count: event.target.value === "" ? undefined : event.target.value === "yes",
                  })}>
                  <option value="">{t("set.ui.capacity.inherit")}</option>
                  <option value="yes">{t("set.ui.yes")}</option>
                  <option value="no">{t("set.ui.no")}</option>
                </select>
                <span className="field-hint">{t("set.ui.capacity.countFieldHint")}</span>
              </label>
            </div>
            <label className="block">
              <span className="eyebrow">{t("set.ui.column.note")}</span>
              <input className="input" value={rule.note}
                placeholder={t("set.ui.capacity.notePlaceholder")}
                onChange={(event) => onNote(event.target.value)} />
            </label>
          </fieldset>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Penerapan massal: satu nilai untuk banyak level/zona sekaligus.
// ---------------------------------------------------------------------------

function BulkApply({
  meta, utilization, onApply, onClose,
}: {
  meta: CapMeta | null;
  utilization: number;
  onApply: (rules: CapRule[]) => void;
  onClose: () => void;
}) {
  const { t, lang } = useT();
  const f = formatters(lang);
  const [wh, setWh] = useState("");
  const [zones, setZones] = useState<string[]>([]);
  const [levels, setLevels] = useState<string[]>([]);
  const [basis, setBasis] = useState<"" | Basis>("");
  const [maxQty, setMaxQty] = useState("");
  const [maxCbm, setMaxCbm] = useState("");
  const [note, setNote] = useState("");

  const zoneOptions = wh ? (meta?.zones?.[wh] ?? []) : [];
  const levelOptions = meta?.levels ?? [];

  const generated = useMemo<CapRule[]>(() => {
    if (!wh || zones.length === 0) return [];
    const set: CapSet = {};
    if (basis) set.basis = basis;
    const qty = numberOrUndefined(maxQty);
    const cbm = numberOrUndefined(maxCbm);
    if (qty !== undefined) set.max_qty = qty;
    if (cbm !== undefined) set.max_cbm = cbm;
    if (!Object.keys(set).length) return [];
    const targets = levels.length ? levels : [""];
    return zones.flatMap((zone) => targets.map((level) => ({
      scope: level ? { wh, zone, level } : { wh, zone },
      set: { ...set },
      note,
    })));
  }, [wh, zones, levels, basis, maxQty, maxCbm, note]);

  const toggle = (list: string[], value: string, setter: (next: string[]) => void) =>
    setter(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);

  return (
    <div className="card card-pad cap-tool">
      <div className="cap-tool-head">
        <div>
          <div className="panel-title">{t("set.ui.capacity.bulkTitle")}</div>
          <p className="cap-hint">{t("set.ui.capacity.bulkIntro")}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
      </div>

      <div className="cap-grid">
        <label>
          <span className="eyebrow">{t("set.ui.column.warehouse")}</span>
          <select className="input" value={wh}
            onChange={(event) => { setWh(event.target.value); setZones([]); }}>
            <option value="">—</option>
            {(meta?.warehouses ?? []).map((code) => <option key={code}>{code}</option>)}
          </select>
        </label>
        <label>
          <span className="eyebrow">{t("set.ui.column.basis")}</span>
          <select className="input" value={basis}
            onChange={(event) => setBasis(event.target.value as "" | Basis)}>
            <option value="">{t("set.ui.capacity.inherit")}</option>
            <option value="qty">Qty</option>
            <option value="cbm">CBM</option>
          </select>
        </label>
        <label>
          <span className="eyebrow">{t("set.ui.column.maxQty")}</span>
          <input type="number" min={0} step="any" inputMode="decimal" className="input num"
            value={maxQty} onChange={(event) => setMaxQty(event.target.value)} />
        </label>
        <label>
          <span className="eyebrow">{t("set.ui.column.maxCbm")}</span>
          <input type="number" min={0} step="any" inputMode="decimal" className="input num"
            value={maxCbm} onChange={(event) => setMaxCbm(event.target.value)} />
          {numberOrUndefined(maxCbm) !== undefined && (
            <span className="field-hint num">
              {t("set.ui.capacity.effectivePreview")}{" "}
              {f.capCbm(numberOrUndefined(maxCbm)! * utilization / 100)} m³
            </span>
          )}
        </label>
      </div>

      <div className="cap-picklist">
        <span className="eyebrow">{t("set.ui.column.zone")}</span>
        {!wh ? (
          <p className="cap-hint">{t("set.ui.capacity.bulkPickWh")}</p>
        ) : zoneOptions.length === 0 ? (
          <p className="cap-hint">{t("set.ui.capacity.zonesNoneForWh")}</p>
        ) : (
          <div className="cap-chips">
            {zoneOptions.map((zone) => (
              <button key={zone} type="button" aria-pressed={zones.includes(zone)}
                className={`zone-chip${zones.includes(zone) ? "" : " is-off"}`}
                onClick={() => toggle(zones, zone, setZones)}>
                <i aria-hidden /><span className="num">{zone}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="cap-picklist">
        <span className="eyebrow">
          {t("set.ui.column.level")} <em>{t("set.ui.capacity.bulkLevelOptional")}</em>
        </span>
        <div className="cap-chips">
          {levelOptions.map((level) => (
            <button key={level} type="button" aria-pressed={levels.includes(level)}
              className={`zone-chip${levels.includes(level) ? "" : " is-off"}`}
              onClick={() => toggle(levels, level, setLevels)}>
              <i aria-hidden /><span className="num">{level}</span>
            </button>
          ))}
        </div>
      </div>

      <label className="block">
        <span className="eyebrow">{t("set.ui.column.note")}</span>
        <input className="input" value={note} onChange={(event) => setNote(event.target.value)} />
      </label>

      <div className="cap-tool-foot">
        <span className="cap-hint num">
          {t("set.ui.capacity.bulkPreview").replace("{n}", String(generated.length))}
        </span>
        <button type="button" className="btn btn-sm btn-primary"
          disabled={generated.length === 0}
          onClick={() => onApply(generated)}>
          {t("set.ui.capacity.bulkApply")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tempel dari spreadsheet — jalan tercepat untuk puluhan aturan SKU.
// ---------------------------------------------------------------------------

const PASTE_COLUMNS = ["wh", "zone", "rack_zone", "level", "storage", "max_qty", "max_cbm", "note"] as const;

interface ParsedPaste {
  rules: CapRule[];
  errors: string[];
  replaced: Set<number>;
}

function parsePaste(text: string, existing: CapRule[]): ParsedPaste {
  const rules: CapRule[] = [];
  const errors: string[] = [];
  const replaced = new Set<number>();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const existingByScope = new Map<string, number>();
  existing.forEach((rule, index) => existingByScope.set(scopeKey(rule.scope), index));

  for (const [lineNumber, line] of lines.entries()) {
    const cells = line.split(/\t|,|;/).map((cell) => cell.trim());
    // Baris judul dari spreadsheet dilewati, bukan ditolak: menyalin bersama
    // headernya adalah hal yang paling wajar dilakukan siapa pun.
    if (lineNumber === 0 && /^(wh|warehouse|gudang)$/i.test(cells[0] ?? "")) continue;
    const [wh, zone, rack, level, storage, qty, cbm, note] = cells;
    if (!wh) { errors.push(`#${lineNumber + 1}: wh`); continue; }
    const scope: CapScope = { wh: wh.toUpperCase() };
    if (zone) scope.zone = zone.toUpperCase();
    if (rack) scope.rack_zone = rack.toUpperCase();
    if (level) scope.level = level.toUpperCase();
    if (storage) scope.storage = storage;
    const set: CapSet = {};
    const qtyValue = spreadsheetNumber(qty ?? "");
    const cbmValue = spreadsheetNumber(cbm ?? "");
    if (qtyValue !== undefined) set.max_qty = qtyValue;
    if (cbmValue !== undefined) set.max_cbm = cbmValue;
    if (!Object.keys(set).length) { errors.push(`#${lineNumber + 1}: max_qty / max_cbm`); continue; }
    if (cbmValue !== undefined) set.basis = "cbm";
    const key = scopeKey(scope);
    const existingIndex = existingByScope.get(key);
    if (existingIndex !== undefined) replaced.add(existingIndex);
    rules.push({ scope, set, note: note ?? "" });
  }
  return { rules, errors, replaced };
}

function PasteRules({
  existing, onApply, onClose,
}: {
  existing: CapRule[];
  onApply: (rules: CapRule[], replaced: Set<number>) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [text, setText] = useState("");
  const parsed = useMemo(() => parsePaste(text, existing), [text, existing]);

  const exportCsv = () => {
    const header = PASTE_COLUMNS.join(",");
    const rows = existing.map((rule) => [
      rule.scope.wh ?? "", rule.scope.zone ?? "", rule.scope.rack_zone ?? "",
      rule.scope.level ?? "", rule.scope.storage ?? "",
      rule.set.max_qty ?? "", rule.set.max_cbm ?? "",
      (rule.note ?? "").replaceAll(",", " "),
    ].join(","));
    void navigator.clipboard?.writeText([header, ...rows].join("\n"));
  };

  return (
    <div className="card card-pad cap-tool">
      <div className="cap-tool-head">
        <div>
          <div className="panel-title">{t("set.ui.capacity.pasteTitle")}</div>
          <p className="cap-hint">{t("set.ui.capacity.pasteIntro")}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
      </div>
      <p className="cap-hint num">{PASTE_COLUMNS.join(" · ")}</p>
      <textarea
        className="input cap-paste-area"
        rows={7}
        value={text}
        placeholder={"CBT\tHRA\t\t2\t\t72\t0,0658\tmezzanine"}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="cap-tool-foot">
        <span className="cap-hint num">
          {t("set.ui.capacity.pastePreview")
            .replace("{n}", String(parsed.rules.length))
            .replace("{r}", String(parsed.replaced.size))}
          {parsed.errors.length > 0 && (
            <em> · {t("set.ui.capacity.pasteSkipped").replace("{n}", String(parsed.errors.length))}</em>
          )}
        </span>
        <div className="cap-actionbar-buttons">
          <button type="button" className="btn btn-sm" onClick={exportCsv}>
            {t("set.ui.capacity.copyCsv")}
          </button>
          <button type="button" className="btn btn-sm btn-primary"
            disabled={parsed.rules.length === 0}
            onClick={() => onApply(parsed.rules, parsed.replaced)}>
            {t("set.ui.capacity.pasteApply")}
          </button>
        </div>
      </div>
      {parsed.errors.length > 0 && (
        <p className="cap-flag">{parsed.errors.slice(0, 5).join(" · ")}</p>
      )}
    </div>
  );
}
