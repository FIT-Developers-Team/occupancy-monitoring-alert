"use client";
// Editor standar CBM per SKU.
//
// APA YANG DIATUR DI SINI, DAN KENAPA IA BUKAN BAGIAN DARI TAB KAPASITAS
// ----------------------------------------------------------------------
// Setiap persentase okupansi CBM adalah sebuah pecahan. Tab Kapasitas mengatur
// PENYEBUTNYA — berapa m³ yang muat di sebuah lokasi. Layar ini mengatur
// PEMBILANGNYA — berapa m³ yang dimakan satu unit sebuah SKU.
//
// Angka pembilang itu datang dari master produk sebagai `sku_cbm`, dan volume
// terpakai pada dataset stok adalah `stock_qty × sku_cbm` — diverifikasi
// terhadap basis data ini: 90.573 baris, nol yang menyimpang. Ketika master
// sebuah SKU salah — diisi dari dimensi kartonnya, dalam satuan yang keliru,
// atau nol — yang terlihat bukan "data master salah", melainkan sebuah gudang
// yang tampak 140% penuh. Memperbaikinya menuntut mengubah master di sistem
// lain dan menunggu sinkronisasi berikutnya.
//
// Nilai yang disimpan di sini menimpa angka sumber data, dan karena volume
// dihitung ulang dari qty × standar baru, SELURUH tampilan langsung memakainya:
// heatmap, okupansi, penjelajah SLOC, alert, ekspor, proyeksi.
//
// Dua hal karena itu wajib ada di layar ini, dan keduanya tidak ada di editor
// mana pun sebelumnya:
//   1. Nilai sumber data ditampilkan berdampingan dengan nilai pengganti, jadi
//      "menimpa" tidak pernah berarti "menyembunyikan".
//   2. Dampaknya dihitung SEBELUM disimpan — berapa m³ yang bergeser, dan
//      berapa persen dari total gudang — karena satu salah ketik desimal di
//      sini menggeser angka okupansi seluruh perusahaan.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n-client";
import { formatters } from "@/lib/utils";

interface SkuStandard {
  sku: string;
  unit_cbm: number;
  note: string;
  updated_at?: string;
  updated_by?: string;
}
interface SkuStandardsConfig { standards: SkuStandard[] }

interface CatalogRow {
  sku: string;
  name: string;
  category: string;
  locations: number;
  qty: number;
  source_unit_cbm: number;
  source_cbm: number;
  warehouses: string[];
}

interface Impact {
  source_cbm: number;
  override_cbm: number;
  total_source_cbm: number;
  matched: number;
  missing: string[];
}

/** Kolom untuk tempel/salin spreadsheet. */
const PASTE_COLUMNS = ["sku", "unit_cbm", "note"] as const;

/**
 * Angka dari sel spreadsheet, dengan koma desimal.
 *
 * `Number("0,0658")` adalah NaN, dan itulah bentuk yang keluar dari setiap
 * spreadsheet berbahasa Indonesia. Tanpa penanganan ini, menempel standar CBM
 * dari Excel akan melewati SETIAP baris tanpa satu pun tanda mengapa.
 */
function spreadsheetNumber(raw: string): number | undefined {
  const trimmed = (raw ?? "").replace(/\s/g, "");
  if (!trimmed) return undefined;
  const hasComma = trimmed.includes(",");
  const hasDot = trimmed.includes(".");
  const normalized = hasComma && hasDot
    ? trimmed.replaceAll(".", "").replace(",", ".")
    : hasComma
      ? trimmed.replace(",", ".")
      : trimmed;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

export default function SkuStandardSettings() {
  const { t, lang } = useT();
  const f = formatters(lang);

  const [standards, setStandards] = useState<SkuStandard[] | null>(null);
  const [baseline, setBaseline] = useState("");
  const [catalog, setCatalog] = useState<Map<string, CatalogRow>>(new Map());
  const [impact, setImpact] = useState<Impact | null>(null);
  const [impactState, setImpactState] = useState<"idle" | "stale" | "ready">("idle");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [tool, setTool] = useState<"none" | "paste">("none");

  // ---- muat -----------------------------------------------------------------
  useEffect(() => {
    let active = true;
    (async () => {
      const response = await fetch("/api/config/sku-standards", { cache: "no-store" });
      const body = await response.json();
      if (!active) return;
      const data = (body.data as SkuStandardsConfig | null)?.standards ?? [];
      setStandards(data);
      setBaseline(JSON.stringify(data));
    })().catch(() => setMessage({ tone: "error", text: t("set.ui.loadError") }));
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = standards !== null && JSON.stringify(standards) !== baseline;

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /** Ambil baris katalog untuk SKU yang sudah punya standar tersimpan. */
  const loadCatalogFor = useCallback(async (skus: string[]) => {
    const missing = skus.filter((sku) => sku && !catalog.has(sku));
    if (!missing.length) return;
    try {
      const response = await fetch(
        `/api/sku-standards/catalog?skus=${encodeURIComponent(missing.slice(0, 200).join(","))}&limit=200`,
      );
      const body = await response.json();
      setCatalog((current) => {
        const next = new Map(current);
        for (const row of (body.rows ?? []) as CatalogRow[]) next.set(row.sku, row);
        return next;
      });
    } catch {
      // Katalog hanya memperkaya tampilan; standarnya tetap dapat diedit.
    }
  }, [catalog]);

  useEffect(() => {
    if (!standards) return;
    void loadCatalogFor(standards.map((entry) => entry.sku));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standards]);

  // ---- dampak ---------------------------------------------------------------
  const signature = standards ? JSON.stringify(standards) : "";
  useEffect(() => {
    if (!standards) return;
    setImpactState("stale");
    const payload = standards.map((entry) => ({ sku: entry.sku, unit_cbm: entry.unit_cbm }));
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/sku-standards/impact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ standards: payload }),
        });
        const body = await response.json();
        if (body?.error) { setImpactState("idle"); return; }
        setImpact(body as Impact);
        setImpactState("ready");
      } catch {
        setImpactState("idle");
      }
    }, 700);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // ---- mutasi ---------------------------------------------------------------
  const update = (next: SkuStandard[]) => { setStandards(next); setMessage(null); };

  const patch = (index: number, values: Partial<SkuStandard>) => {
    if (!standards) return;
    const next = [...standards];
    next[index] = { ...next[index], ...values };
    update(next);
  };

  const remove = (index: number) => {
    if (!standards) return;
    update(standards.filter((_, i) => i !== index));
  };

  const addStandard = (row: CatalogRow) => {
    if (!standards) return;
    if (standards.some((entry) => entry.sku === row.sku)) return;
    setCatalog((current) => new Map(current).set(row.sku, row));
    update([
      // Baris baru masuk paling atas: itu yang barusan dicari admin, dan
      // menaruhnya di ujung daftar 200 baris membuatnya hilang dari pandangan.
      { sku: row.sku, unit_cbm: row.source_unit_cbm || 0.001, note: "" },
      ...standards,
    ]);
  };

  async function save() {
    if (!standards) return;
    setBusy(true); setMessage(null); setIssues({});
    try {
      const response = await fetch("/api/config/sku-standards", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ standards }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const found: Record<string, string> = {};
        for (const issue of (body.issues ?? []) as Array<{ path: string[]; message: string }>) {
          if (issue.path[0] === "standards" && issue.path[1] !== undefined) {
            found[issue.path[1]] = issue.message;
          }
        }
        setIssues(found);
        setMessage({ tone: "error", text: body.error || t("set.ui.saveError") });
        return;
      }
      const saved = (body.data as SkuStandardsConfig).standards;
      setStandards(saved);
      setBaseline(JSON.stringify(saved));
      setMessage({ tone: "ok", text: t("set.ui.sku.saved") });
    } catch (error) {
      setMessage({ tone: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function revert() {
    if (!baseline) return;
    setStandards(JSON.parse(baseline) as SkuStandard[]);
    setIssues({});
    setMessage(null);
  }

  const visible = useMemo(() => {
    if (!standards) return [] as Array<{ entry: SkuStandard; index: number }>;
    const needle = filter.trim().toLowerCase();
    return standards
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => {
        if (!needle) return true;
        const row = catalog.get(entry.sku);
        return [entry.sku, entry.note, row?.name, row?.category]
          .filter(Boolean).join(" ").toLowerCase().includes(needle);
      });
  }, [standards, filter, catalog]);

  if (!standards) {
    return (
      <div className="settings-panel-loading" role="status" aria-live="polite">
        <div className="settings-panel-loading-head"><span /><strong /></div>
        <div className="settings-panel-loading-grid"><span /><span /></div>
        <span className="sr-only">{t("set.ui.sku.loading")}</span>
      </div>
    );
  }

  const delta = impact ? impact.override_cbm - impact.source_cbm : 0;
  const deltaPct = impact && impact.total_source_cbm > 0
    ? (delta / impact.total_source_cbm) * 100
    : 0;

  return (
    <div className="cap-settings">
      <section className="card card-pad sku-intro">
        <div className="panel-title">{t("set.ui.sku.title")}</div>
        <p className="cap-hint">{t("set.ui.sku.intro")}</p>
        <p className="cap-hint num">
          {t("set.ui.sku.formula")}
        </p>
      </section>

      {message && (
        <p className={`settings-message${message.tone === "error" ? " is-error" : ""}`} role="status">
          {message.text}
        </p>
      )}

      <SkuPicker
        existing={new Set(standards.map((entry) => entry.sku))}
        onPick={addStandard}
      />

      <section className="cap-rules">
        <header className="cap-rules-head">
          <div className="min-w-0">
            <div className="panel-title">{t("set.ui.sku.listTitle")}</div>
            <p className="cap-hint">{t("set.ui.sku.listHint")}</p>
          </div>
          <div className="cap-rules-stats">
            <span className="chip num">
              {standards.length} {t("set.ui.sku.countLabel")}
            </span>
            {impact && impact.missing.length > 0 && (
              <span className="chip num cap-chip-warn" title={impact.missing.join(", ")}>
                {impact.missing.length} {t("set.ui.sku.missingLabel")}
              </span>
            )}
          </div>
        </header>

        {/* Dampak total: satu baris yang menjawab "berapa yang bergeser kalau
            saya simpan ini". Tanpa ini, satu salah ketik desimal baru terlihat
            sebagai gudang yang mendadak 140% penuh. */}
        <div className={`sku-impact${impactState === "stale" ? " is-stale" : ""}`}>
          {impact === null ? (
            <span className="cap-hint">{t("set.ui.sku.impactPending")}</span>
          ) : (
            <>
              <div>
                <span className="eyebrow">{t("set.ui.sku.impactSource")}</span>
                <strong className="num">{f.cbm(impact.source_cbm)} m³</strong>
              </div>
              <span aria-hidden className="sku-impact-arrow">→</span>
              <div>
                <span className="eyebrow">{t("set.ui.sku.impactOverride")}</span>
                <strong className="num">{f.cbm(impact.override_cbm)} m³</strong>
              </div>
              <div className={`sku-impact-delta${delta > 0 ? " is-up" : delta < 0 ? " is-down" : ""}`}>
                <span className="eyebrow">{t("set.ui.sku.impactDelta")}</span>
                <strong className="num">
                  {delta > 0 ? "+" : ""}{f.cbm(delta)} m³
                  {impact.total_source_cbm > 0 && (
                    <em> ({delta > 0 ? "+" : ""}{f.pct(deltaPct, 2)} {t("set.ui.sku.ofTotal")})</em>
                  )}
                </strong>
              </div>
            </>
          )}
        </div>

        <div className="cap-toolbar">
          <input
            type="search"
            className="input cap-search"
            placeholder={t("set.ui.sku.filterPlaceholder")}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            aria-label={t("set.ui.sku.filterPlaceholder")}
          />
          <button
            type="button"
            className={`btn btn-sm${tool === "paste" ? " btn-primary" : ""}`}
            onClick={() => setTool(tool === "paste" ? "none" : "paste")}
          >
            {t("set.ui.sku.pasteOpen")}
          </button>
          <span className={`cap-impact-state is-${impactState}`}>
            {impactState === "stale" ? t("set.ui.sku.impactChecking") : t("set.ui.sku.impactReady")}
          </span>
        </div>

        {tool === "paste" && (
          <PasteStandards
            existing={standards}
            onApply={(next) => { update(next); setTool("none"); }}
            onClose={() => setTool("none")}
          />
        )}

        {visible.length === 0 ? (
          <p className="cap-empty">
            {standards.length === 0 ? t("set.ui.sku.empty") : t("set.ui.sku.noMatch")}
          </p>
        ) : (
          <div className="sku-table-wrap">
            <table className="tbl sku-table">
              <thead>
                <tr>
                  <th>{t("set.ui.sku.colSku")}</th>
                  <th>{t("set.ui.sku.colProduct")}</th>
                  <th className="num">{t("set.ui.sku.colSource")}</th>
                  <th className="num">{t("set.ui.sku.colStandard")}</th>
                  <th className="num">{t("set.ui.sku.colStock")}</th>
                  <th className="num">{t("set.ui.sku.colDelta")}</th>
                  <th>{t("set.ui.column.note")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map(({ entry, index }) => {
                  const row = catalog.get(entry.sku);
                  const source = row?.source_unit_cbm ?? 0;
                  const rowDelta = row ? row.qty * entry.unit_cbm - row.source_cbm : null;
                  const ratio = source > 0 ? entry.unit_cbm / source : null;
                  const issue = issues[String(index)];
                  // Selisih besar hampir selalu salah ketik desimal, bukan
                  // keputusan: 10× dan 0,1× adalah jarak antara "0,0658" dan
                  // "0,658".
                  const suspicious = ratio !== null && (ratio >= 10 || ratio <= 0.1);
                  return (
                    <tr key={entry.sku} className={issue ? "is-invalid" : suspicious ? "is-warned" : ""}>
                      <td className="num">
                        <strong>{entry.sku}</strong>
                        {row && row.warehouses.length > 0 && (
                          <small>{row.warehouses.join(" ")}</small>
                        )}
                      </td>
                      <td>
                        <span className="sku-name">{row?.name || t("set.ui.sku.unknownProduct")}</span>
                        {row?.category && <small>{row.category}</small>}
                      </td>
                      <td className="num">
                        {source > 0 ? f.capCbm(source) : "—"}
                      </td>
                      <td>
                        <input
                          type="number" min={0} step="any" inputMode="decimal"
                          className="input num sku-input"
                          value={entry.unit_cbm}
                          onChange={(event) => patch(index, {
                            unit_cbm: Number(event.target.value),
                          })}
                          aria-label={`${t("set.ui.sku.colStandard")} ${entry.sku}`}
                        />
                        {ratio !== null && (
                          <span className={`sku-ratio${suspicious ? " is-warn" : ""}`}>
                            ×{f.num(ratio, ratio >= 10 ? 0 : 2)}
                          </span>
                        )}
                      </td>
                      <td className="num">
                        {row ? (
                          <>
                            {f.num(row.qty)}
                            <small>{f.num(row.locations)} {t("set.ui.sku.locations")}</small>
                          </>
                        ) : "—"}
                      </td>
                      <td className="num">
                        {rowDelta === null ? "—" : (
                          <span className={rowDelta > 0 ? "sku-up" : rowDelta < 0 ? "sku-down" : ""}>
                            {rowDelta > 0 ? "+" : ""}{f.cbm(rowDelta)}
                          </span>
                        )}
                      </td>
                      <td>
                        <input
                          className="input"
                          value={entry.note}
                          placeholder={t("set.ui.sku.notePlaceholder")}
                          onChange={(event) => patch(index, { note: event.target.value })}
                        />
                        {entry.updated_at && (
                          <small title={entry.updated_by}>
                            {f.dateTime(entry.updated_at)}
                            {entry.updated_by ? ` · ${entry.updated_by}` : ""}
                          </small>
                        )}
                        {issue && <small className="sku-issue">{issue}</small>}
                      </td>
                      <td>
                        <div className="sku-row-actions">
                          {source > 0 && entry.unit_cbm !== source && (
                            <button
                              type="button" className="btn btn-ghost btn-sm"
                              title={t("set.ui.sku.resetToSource")}
                              onClick={() => patch(index, { unit_cbm: source })}
                            >↺</button>
                          )}
                          <button
                            type="button" className="btn btn-ghost btn-sm"
                            aria-label={t("set.ui.sku.remove")}
                            title={t("set.ui.sku.remove")}
                            onClick={() => remove(index)}
                          >✕</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className={`cap-actionbar${dirty ? " is-dirty" : ""}`}>
        <div className="cap-actionbar-status">
          <strong>{t("set.ui.sku.title")}</strong>
          <span>{dirty ? t("set.ui.capacity.unsaved") : t("set.ui.capacity.allSaved")}</span>
        </div>
        <div className="cap-actionbar-buttons">
          <button type="button" className="btn btn-sm" disabled={!dirty || busy} onClick={revert}>
            {t("set.ui.capacity.revert")}
          </button>
          <button type="button" className="btn btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? t("set.ui.capacity.saving") : t("set.ui.sku.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pemilih SKU: pencarian sisi server dengan jejak stoknya.
// ---------------------------------------------------------------------------

function SkuPicker({
  existing, onPick,
}: {
  existing: Set<string>;
  onPick: (row: CatalogRow) => void;
}) {
  const { t, lang } = useT();
  const f = formatters(lang);
  const [term, setTerm] = useState("");
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [touched, setTouched] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!touched) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(
          `/api/sku-standards/catalog?q=${encodeURIComponent(term)}&limit=25`,
          { signal: controller.signal },
        );
        const body = await response.json();
        setRows((body.rows ?? []) as CatalogRow[]);
        setTotal(Number(body.total ?? 0));
      } catch {
        // Pencarian yang dibatalkan bukan galat.
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [term, touched]);

  return (
    <section className="card card-pad sku-picker">
      <div className="panel-title">{t("set.ui.sku.pickerTitle")}</div>
      <p className="cap-hint">{t("set.ui.sku.pickerHint")}</p>
      <input
        className="input"
        value={term}
        placeholder={t("set.ui.sku.pickerPlaceholder")}
        onChange={(event) => { setTerm(event.target.value); setTouched(true); }}
        onFocus={() => setTouched(true)}
      />
      {touched && (
        <div className="sku-picker-results">
          {loading && <p className="cap-hint">{t("set.ui.sku.searching")}</p>}
          {!loading && rows.length === 0 && <p className="cap-hint">{t("set.ui.sku.noResult")}</p>}
          {rows.map((row) => {
            const already = existing.has(row.sku);
            return (
              <button
                key={row.sku}
                type="button"
                className="sku-picker-row"
                disabled={already}
                onClick={() => onPick(row)}
                title={already ? t("set.ui.sku.alreadyAdded") : t("set.ui.sku.addThis")}
              >
                <strong className="num">{row.sku}</strong>
                <span className="truncate">{row.name}</span>
                <span className="num">
                  {f.capCbm(row.source_unit_cbm)} m³ · {f.num(row.qty)} {t("common.unit")}
                  {" · "}{f.num(row.locations)} {t("set.ui.sku.locations")}
                </span>
                <span className="sku-picker-cta">{already ? "✓" : "+"}</span>
              </button>
            );
          })}
          {total > rows.length && (
            <p className="cap-hint num">
              {t("set.ui.sku.moreResults").replace("{n}", String(total - rows.length))}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tempel dari spreadsheet — jalan tercepat untuk puluhan standar sekaligus.
// ---------------------------------------------------------------------------

function parsePaste(text: string, existing: SkuStandard[]): {
  standards: SkuStandard[]; added: number; changed: number; skipped: number;
} {
  const byS = new Map(existing.map((entry) => [entry.sku, entry]));
  const result = new Map(byS);
  let added = 0;
  let changed = 0;
  let skipped = 0;
  for (const [lineNumber, line] of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).entries()) {
    const cells = line.split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)|;/).map((cell) => cell.trim());
    // Baris judul dari spreadsheet dilewati, bukan ditolak: menyalin bersama
    // headernya adalah hal yang paling wajar dilakukan siapa pun.
    if (lineNumber === 0 && /^sku(_number)?$/i.test(cells[0] ?? "")) continue;
    const sku = (cells[0] ?? "").toUpperCase();
    const unit = spreadsheetNumber(cells[1] ?? "");
    if (!sku || unit === undefined || unit <= 0) { skipped += 1; continue; }
    const previous = byS.get(sku);
    if (previous) {
      if (previous.unit_cbm !== unit || previous.note !== (cells[2] ?? previous.note)) changed += 1;
    } else {
      added += 1;
    }
    result.set(sku, { sku, unit_cbm: unit, note: cells[2] ?? previous?.note ?? "" });
  }
  return { standards: [...result.values()], added, changed, skipped };
}

function PasteStandards({
  existing, onApply, onClose,
}: {
  existing: SkuStandard[];
  onApply: (standards: SkuStandard[]) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [text, setText] = useState("");
  const parsed = useMemo(() => parsePaste(text, existing), [text, existing]);

  const copyCsv = () => {
    const rows = existing.map((entry) =>
      [entry.sku, entry.unit_cbm, (entry.note ?? "").replaceAll(",", " ")].join(","));
    void navigator.clipboard?.writeText([PASTE_COLUMNS.join(","), ...rows].join("\n"));
  };

  return (
    <div className="card card-pad cap-tool">
      <div className="cap-tool-head">
        <div>
          <div className="panel-title">{t("set.ui.sku.pasteTitle")}</div>
          <p className="cap-hint">{t("set.ui.sku.pasteIntro")}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
      </div>
      <p className="cap-hint num">{PASTE_COLUMNS.join(" · ")}</p>
      <textarea
        className="input cap-paste-area"
        rows={7}
        value={text}
        placeholder={"8993496107068\t0,006776\tukur ulang gudang CBT"}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="cap-tool-foot">
        <span className="cap-hint num">
          {t("set.ui.sku.pastePreview")
            .replace("{a}", String(parsed.added))
            .replace("{c}", String(parsed.changed))}
          {parsed.skipped > 0 && (
            <em> · {t("set.ui.sku.pasteSkipped").replace("{n}", String(parsed.skipped))}</em>
          )}
        </span>
        <div className="cap-actionbar-buttons">
          <button type="button" className="btn btn-sm" onClick={copyCsv}>
            {t("set.ui.sku.copyCsv")}
          </button>
          <button
            type="button" className="btn btn-sm btn-primary"
            disabled={parsed.added === 0 && parsed.changed === 0}
            onClick={() => onApply(parsed.standards)}
          >
            {t("set.ui.capacity.pasteApply")}
          </button>
        </div>
      </div>
    </div>
  );
}
