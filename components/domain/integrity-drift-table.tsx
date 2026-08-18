"use client";
// Tabel selisih cycle count dengan pencarian SLOC, filter jenis selisih, dan
// ekspor Excel yang mengikuti filter yang sama.
//
// Penyaringan dilakukan di klien karena daftar selisih dibatasi beberapa ratus
// baris pada muat awal; tombol ekspor tetap meminta ulang ke server sehingga
// berkas berisi SELURUH selisih yang cocok, bukan hanya yang sempat dimuat.
import { useMemo, useState } from "react";
import type { IntegrityDriftRow } from "@/lib/queries";
import { DRIFT_TYPES } from "@/lib/sloc-filter";
import { useT } from "@/lib/i18n-client";
import ExportExcelButton from "@/components/domain/export-excel-button";

function formatNumber(value: number, locale: string) {
  return Number.isFinite(value) ? value.toLocaleString(locale) : "—";
}

function formatDate(value: string, locale: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "—";
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Jakarta",
  }).format(date);
}

const DRIFT_BADGE: Record<string, string> = {
  PHANTOM: "badge badge-critical",
  GHOST: "badge badge-warning",
  SELISIH: "badge badge-monitor",
};

export default function IntegrityDriftTable({
  rows,
  warehouse,
  loadedLimit,
}: {
  rows: IntegrityDriftRow[];
  warehouse?: string;
  /** Berapa baris yang dimuat halaman — dipakai memberi tahu bila terpotong. */
  loadedLimit: number;
}) {
  const { t, lang } = useT();
  const locale = lang === "en" ? "en-GB" : "id-ID";
  const [query, setQuery] = useState("");
  const [driftType, setDriftType] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return rows.filter((row) => {
      if (driftType && row.drift_type !== driftType) return false;
      if (!needle) return true;
      return `${row.sloc_code} ${row.warehouse}`.toLocaleLowerCase().includes(needle);
    });
  }, [driftType, query, rows]);

  const exportParams = useMemo(() => {
    const params = new URLSearchParams();
    if (warehouse) params.set("wh", warehouse);
    if (query.trim()) params.set("q", query.trim());
    if (driftType) params.set("drift", driftType);
    return params;
  }, [driftType, query, warehouse]);

  return (
    <>
      <div className="filter-toolbar">
        <label>
          <span className="sr-only">{t("intx.search")}</span>
          <input className="input" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder={t("intx.search")} autoComplete="off" spellCheck={false} />
        </label>
        <label>
          <span className="sr-only">{t("export.driftType")}</span>
          <select className="input" value={driftType} onChange={(event) => setDriftType(event.target.value)}>
            <option value="">{t("intx.allDrifts")}</option>
            {DRIFT_TYPES.map((type) => (
              <option key={type} value={type}>{t(`int.ui.drift.${type}`, type)}</option>
            ))}
          </select>
        </label>
        <span className="filter-toolbar-spacer">
          <span className="filter-count num">
            {filtered.length.toLocaleString(locale)}/{rows.length.toLocaleString(locale)}
            {rows.length >= loadedLimit ? "+" : ""}
          </span>
          <ExportExcelButton dataset="integrity" params={exportParams} title={t("export.fullHint")} />
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t("common.warehouse")}</th>
              <th>{t("common.sloc")}</th>
              <th>{t("int.ui.countDate")}</th>
              <th className="text-right">{t("int.ui.system")}</th>
              <th className="text-right">{t("int.ui.physical")}</th>
              <th className="text-right">{t("int.ui.difference")}</th>
              <th>{t("int.ui.kind")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row, index) => (
              <tr key={`${row.warehouse}-${row.sloc_code}-${index}`}>
                <td className="num font-semibold">{row.warehouse}</td>
                <td className="num">{row.sloc_code}</td>
                <td className="num">{formatDate(row.count_date, locale)}</td>
                <td className="num text-right">{formatNumber(Number(row.system_qty), locale)}</td>
                <td className="num text-right">{formatNumber(Number(row.physical_qty), locale)}</td>
                <td className="num text-right font-semibold"
                  style={{ color: Number(row.diff) < 0 ? "var(--st-critical-fg)" : "var(--st-warning-fg)" }}>
                  {Number(row.diff) > 0 ? "+" : ""}{formatNumber(Number(row.diff), locale)}
                </td>
                <td>
                  <span className={DRIFT_BADGE[row.drift_type] ?? "badge badge-monitor"}>
                    {t(`int.ui.drift.${row.drift_type}`, row.drift_type)}
                  </span>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="py-8 text-center text-xs" style={{ color: "var(--text-muted)" }}>
                  {rows.length === 0
                    ? `${t("int.ui.noDrift")}${warehouse ? ` ${t("int.ui.forWarehouse")} ${warehouse}` : ""}.`
                    : t("intx.noMatches")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
