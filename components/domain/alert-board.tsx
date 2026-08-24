"use client";
// Papan alert per gudang + panel detail.
//
// Panel ini dulu memuat tiga blok teks: `detail` alert, lalu "Tentang aturan
// ini", lalu "Tindakan" — dua terakhir diambil dari keterangan aturan yang
// sama untuk setiap alert dengan rule_id yang sama. Setelah alert dijadikan
// berbasis kejadian, `detail` sudah menyebut penyebabnya, angkanya, dan berapa
// yang harus dipindahkan; dua blok sisanya hanya mengulang hal umum yang sudah
// diketahui pembacanya, dan justru mendorong angka yang penting turun ke bawah
// layar.
import Link from "next/link";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { Alert, Severity } from "@/types";
import { formatters, severityOrder } from "@/lib/utils";
import { useT } from "@/lib/i18n-client";
import { SEVERITY_TONE } from "@/lib/status-tone";
import { trapFocus } from "@/lib/focus-trap";
import { SeverityBadge, AlertStatusBadge } from "@/components/ui/badges";
import AlertActions from "@/components/domain/alert-actions";
import ExportExcelButton from "@/components/domain/export-excel-button";

export interface AlertEvent {
  id: string; alert_id: string; at: string; actor: string; action: string; note: string | null;
}

export default function AlertBoard({
  alerts, events, writable, levels, initialId, exportGroup,
}: {
  alerts: Alert[];
  events: Record<string, AlertEvent[]>;
  writable: boolean;
  levels: Record<number, string>;
  initialId?: string;
  /** Kelompok status yang dimuat papan ini — dipakai ekspor agar cakupannya sama. */
  exportGroup?: "open" | "acknowledged" | "closed" | "all";
}) {
  const { t, lang } = useT();
  const f = formatters(lang);
  const [wh, setWh] = useState<string>("");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [severity, setSeverity] = useState<Severity | "">("");
  const [rule, setRule] = useState("");
  const [sel, setSel] = useState<Alert | null>(
    initialId ? alerts.find((a) => a.alert_id === initialId) ?? null : null);

  const whs = useMemo(
    () => [...new Set(alerts.map((a) => a.warehouse_code))].sort(), [alerts]);
  const rules = useMemo(
    () => [...new Set(alerts.map((a) => a.rule_id))].sort(), [alerts]);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of alerts) m[a.warehouse_code] = (m[a.warehouse_code] ?? 0) + 1;
    return m;
  }, [alerts]);
  // Berapa banyak alert di setiap tingkat keparahan. Dipakai deretan filter di
  // bawah agar "seberapa buruk keadaan sekarang" terbaca sebelum satu baris pun
  // dibuka — dan sekaligus mengajarkan urutan warnanya.
  const severityCounts = useMemo(() => {
    const m: Partial<Record<Severity, number>> = {};
    for (const a of alerts) m[a.severity] = (m[a.severity] ?? 0) + 1;
    return m;
  }, [alerts]);
  const worstFirst = useMemo(
    () => [...severityOrder].reverse().filter((value) => severityCounts[value]),
    [severityCounts],
  );
  const shown = useMemo(() => {
    const tokens = deferredQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return alerts.filter((alert) => {
      if (wh && alert.warehouse_code !== wh) return false;
      if (severity && alert.severity !== severity) return false;
      if (rule && alert.rule_id !== rule) return false;
      if (!tokens.length) return true;
      // Judul dan detail ikut dicari: operator biasanya ingat kalimat alert,
      // bukan kode aturannya.
      const haystack = [
        alert.warehouse_code, alert.zone, alert.sloc_code, alert.sku,
        alert.title, alert.detail, alert.rule_id, alert.rule_name,
      ].filter(Boolean).join(" ").toLocaleLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
  }, [alerts, deferredQuery, rule, severity, wh]);

  const dialogTrigger = useRef<HTMLElement | null>(null);
  const openAlert = (alert: Alert) => {
    dialogTrigger.current = document.activeElement as HTMLElement | null;
    setSel(alert);
  };
  const closeAlert = () => {
    setSel(null);
    requestAnimationFrame(() => dialogTrigger.current?.focus());
  };
  useEffect(() => {
    if (!sel) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [sel]);

  const exportParams = useMemo(() => {
    const params = new URLSearchParams({ group: exportGroup ?? "all" });
    if (wh) params.set("wh", wh);
    if (severity) params.set("severity", severity);
    if (rule) params.set("rule", rule);
    if (deferredQuery.trim()) params.set("q", deferredQuery.trim());
    return params;
  }, [deferredQuery, exportGroup, rule, severity, wh]);

  return (
    <>
      <div className="filter-toolbar">
        <label>
          <span className="sr-only">{t("alertx.search")}</span>
          <input className="input" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder={t("alertx.search")} autoComplete="off" spellCheck={false} />
        </label>
        <label>
          <span className="sr-only">{t("alert.severity")}</span>
          <select className="input" value={severity}
            onChange={(event) => setSeverity(event.target.value as Severity | "")}>
            <option value="">{t("alertx.allSeverities")}</option>
            {[...severityOrder].reverse().map((value) => (
              <option key={value} value={value}>{t(`severity.${value}`)}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">{t("alert.rule")}</span>
          <select className="input" value={rule} onChange={(event) => setRule(event.target.value)}>
            <option value="">{t("alertx.allRules")}</option>
            {rules.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <span className="filter-toolbar-spacer">
          <span className="filter-count num">{shown.length}/{alerts.length}</span>
          <ExportExcelButton dataset="alerts" params={exportParams}
            disabled={shown.length === 0} title={t("export.fullHint")} />
        </span>
      </div>

      {worstFirst.length > 0 && (
        <div className="severity-filter" role="group" aria-label={t("alert.severity")}>
          {worstFirst.map((value) => (
            <button
              key={value}
              type="button"
              className={`severity-filter-item severity-${SEVERITY_TONE[value]}${severity === value ? " is-active" : ""}`}
              aria-pressed={severity === value}
              onClick={() => setSeverity((current) => (current === value ? "" : value))}
            >
              <i aria-hidden="true" />
              <span>{t(`severity.${value}`)}</span>
              <b className="num">{severityCounts[value]}</b>
            </button>
          ))}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <button className={`chip ${wh === "" ? "chip-accent" : ""}`} onClick={() => setWh("")}>
          {t("common.allWarehouses")} {alerts.length}
        </button>
        {whs.map((w) => (
          <button key={w} className={`chip ${wh === w ? "chip-accent" : ""}`} onClick={() => setWh(w)}>
            {w} {counts[w]}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="py-6 text-center text-xs" style={{ color: "var(--text-muted)" }}>
          {alerts.length === 0 ? t("common.none") : t("alertx.noMatches")}
        </p>
      ) : (
        <ul className="alert-list">
          {shown.map((a) => (
            <li key={a.alert_id}>
              {/* Pita kiri berwarna keparahan: satu baris dapat dinilai tanpa
                  membaca lencananya, dan daftar panjang tetap dapat dipindai. */}
              <button className={`alert-row severity-${SEVERITY_TONE[a.severity]}`}
                onClick={() => openAlert(a)}>
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={a.severity} />
                  <span className="num text-[13px] font-semibold">{a.warehouse_code}</span>
                  {a.zone && <span className="chip">{a.zone}</span>}
                  {a.sloc_code && <span className="chip num">{a.sloc_code}</span>}
                  <span className="ml-auto flex items-center gap-2">
                    <span className="eyebrow">{levels[a.escalation_level] ?? `L${a.escalation_level}`}</span>
                    <AlertStatusBadge status={a.status} />
                  </span>
                </div>
                <div className="mt-1 text-[12.5px] font-semibold">{a.title}</div>
                <div className="alert-row-detail">{a.detail}</div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {sel && (
        <div className="alert-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) closeAlert();
          }}>
          <div
            className={`card anim-in alert-dialog severity-${SEVERITY_TONE[sel.severity]}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="alert-detail-title"
            onKeyDown={(event) => {
              trapFocus(event);
              if (event.key === "Escape") closeAlert();
            }}
          >
            <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-4"
              style={{ borderBottom: "1px solid var(--border)" }}>
              <div className="min-w-0">
                <div className="eyebrow">{t("alert.detail")} · {sel.rule_id}</div>
                <h3 id="alert-detail-title" className="panel-title">{sel.title}</h3>
              </div>
              <button className="btn btn-ghost btn-sm" autoFocus onClick={closeAlert}
                aria-label={t("action.close")}>{t("action.close")}</button>
            </div>
            <div className="space-y-3 px-4 py-3 text-[12.5px]">
              <div className="flex flex-wrap items-center gap-2">
                <SeverityBadge severity={sel.severity} />
                <AlertStatusBadge status={sel.status} />
                <span className="chip num">{sel.warehouse_code}</span>
                {sel.zone && <span className="chip">{sel.zone}</span>}
                {sel.sloc_code && <span className="chip num">{sel.sloc_code}</span>}
                {sel.sku && <span className="chip num">{t("common.skuNo")} {sel.sku}</span>}
              </div>
              <div>
                <div className="eyebrow mb-1">{t("alert.reading")}</div>
                {/* Angka Qty dan CBM lokasi/zona ini berikut tindakannya.
                    Sebelumnya blok ini menampilkan keterangan umum aturan, dan
                    satu-satunya tempat angkanya tertulis tidak pernah terlihat. */}
                <p className="alert-detail-body">{sel.detail}</p>
              </div>
              {/* Alert kini selalu berasal dari satu pergerakan ke satu lokasi,
                  jadi dua pertanyaan berikutnya selalu sama: "lokasinya seperti
                  apa sekarang" dan "apa saja yang masuk ke sana". Sebelumnya
                  keduanya menuntut orang menyalin kode SLOC lalu mencarinya
                  sendiri di dua halaman berbeda. */}
              {sel.sloc_code && (
                <div className="alert-detail-links">
                  <Link className="chip chip-accent" prefetch={false}
                    href={`/heatmap?wh=${encodeURIComponent(sel.warehouse_code)}&sloc=${encodeURIComponent(sel.sloc_code)}`}>
                    {t("alert.openLocation")} →
                  </Link>
                  <Link className="chip" prefetch={false}
                    href={`/movements?sloc=${encodeURIComponent(sel.sloc_code)}&range=24h`}>
                    {t("alert.openMovements")} →
                  </Link>
                </div>
              )}
              <div className="alert-detail-metrics">
                <div>
                  <div className="eyebrow">{t("alert.occurrences")}</div>
                  <div className="num font-semibold">{sel.occurrences}×</div>
                </div>
                <div>
                  <div className="eyebrow">{t("alert.escalation")}</div>
                  <div className="text-[12px] font-semibold">{levels[sel.escalation_level] ?? `L${sel.escalation_level}`}</div>
                </div>
                <div>
                  <div className="eyebrow">{t("common.time")}</div>
                  <div className="num text-[11px] font-semibold">{f.dateTime(sel.created_at)}</div>
                </div>
              </div>
              {(events[sel.alert_id] ?? []).length > 0 && (
                <div>
                  <div className="eyebrow mb-1">{t("alert.escalation")}</div>
                  <ul className="space-y-1">
                    {(events[sel.alert_id] ?? []).slice(0, 6).map((e) => (
                      <li key={e.id} className="flex justify-between gap-2 text-[11px]"
                        style={{ color: "var(--text-muted)" }}>
                        <span>{e.action}{e.note ? ` — ${e.note}` : ""}</span>
                        <span className="num shrink-0">{f.dateTime(e.at)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 px-4 py-3" style={{ borderTop: "1px solid var(--border)" }}>
              <AlertActions alertId={sel.alert_id} status={sel.status} canWrite={writable} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
