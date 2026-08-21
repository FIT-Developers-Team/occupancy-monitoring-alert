import Link from "next/link";
import { getWarehouseDashboard, getIntegrity, getOccupancyScopeQuality } from "@/lib/queries";
import { thresholdsFor } from "@/lib/config";
import { listAlerts, activeCountsBySeverity } from "@/lib/alerts/store";
import { getBasisMode } from "@/lib/basis";
import { getLang, getT } from "@/lib/i18n";
import { formatters } from "@/lib/utils";
import KpiCard from "@/components/ui/kpi-card";
import Section from "@/components/ui/section";
import { StatusBadge, SeverityBadge } from "@/components/ui/badges";
import TrendChart from "@/components/charts/trend-chart-lazy";
import WarehouseOverviewTable from "@/components/domain/warehouse-overview-table";
import PageHeader from "@/components/ui/page-header";
import PrefetchLink from "@/components/ui/prefetch-link";
import { SEVERITY_TONE } from "@/lib/status-tone";
import { pageTitle } from "@/lib/page-metadata";

export const dynamic = "force-dynamic";
export const generateMetadata = pageTitle("nav.exec");

const STATUS_RANK = { BREACH: 0, CRITICAL: 1, WARNING: 2, MONITOR: 3, NORMAL: 4 } as const;

export default async function ExecutivePage() {
  const [mode, t, lang] = await Promise.all([getBasisMode(), getT(), getLang()]);
  const f = formatters(lang);
  const [warehouseData, integrity, active, counts, scopeQuality] = await Promise.all([
    getWarehouseDashboard(),
    getIntegrity().catch(() => []),
    listAlerts({ status: ["NEW", "NOTIFIED", "ACKNOWLEDGED"], limit: 6 }),
    activeCountsBySeverity(),
    getOccupancyScopeQuality(),
  ]);
  const { summaries: sums, trend } = warehouseData;
  const thresholdMap = Object.fromEntries(sums.map((w) => [w.code, thresholdsFor(w.code)]));

  const qOcc = sums.reduce((s, w) => s + w.occ_qty, 0);
  const qCap = sums.reduce((s, w) => s + w.cap_qty, 0);
  const vOcc = sums.reduce((s, w) => s + w.occ_cbm, 0);
  const vCap = sums.reduce((s, w) => s + w.cap_cbm, 0);
  const netQ = qCap ? (qOcc / qCap) * 100 : null;
  const netV = vCap ? (vOcc / vCap) * 100 : null;
  const slocTotal = sums.reduce((s, w) => s + w.sloc_total, 0);
  const slocFilled = sums.reduce((s, w) => s + w.sloc_occupied, 0);
  const netBin = slocTotal ? (slocFilled / slocTotal) * 100 : 0;
  const totalActive = Object.values(counts).reduce((a, b) => a + b, 0);
  const worstSev =
    (["EMERGENCY", "CRITICAL", "HIGH", "WARNING", "INFO"] as const).find((s) => counts[s]) ?? null;
  const integrityAvg = integrity.length
    ? integrity.reduce((s, r) => s + r.integrity_pct, 0) / integrity.length : null;
  const unzonedActive = scopeQuality.reduce((n, r) => n + r.active_without_zone, 0);
  const unmappedStock = scopeQuality.reduce((n, r) => n + r.stock_without_operational_sloc, 0);
  const topRisk = [...sums].sort((a, b) => {
    const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    return r !== 0 ? r : (a.hours_to_95 ?? 1e9) - (b.hours_to_95 ?? 1e9);
  }).slice(0, 4);

  // KPI jaringan memakai tangga yang sama dengan sisa aplikasi, termasuk
  // tingkat teratasnya: 100% ke atas berarti kapasitas terlampaui dan harus
  // tampil merah, bukan berhenti di oranye seperti sebelumnya.
  const tone = (p: number | null) =>
    p === null ? undefined
    : p >= 100 ? "breach" as const
    : p >= 95 ? "critical" as const
    : p >= 85 ? "warning" as const
    : p >= 70 ? "monitor" as const
    : "normal" as const;

  return (
    <div className="dashboard-page">
      <PageHeader title={t("exec.title")} />

      <div className="metric-strip metric-strip-five">
        <KpiCard label={t("exec.qtyOcc")} value={netQ === null ? "—" : f.pct(netQ)} tone={tone(netQ)}
          sub={`${f.num(qOcc)} / ${f.num(qCap)} ${t("common.unit")}`} />
        {/* Penyebutnya kapasitas efektif (sudah dikali utilisasi volume);
            pembagian dengan f.num(…, 0) juga membuang seluruh desimal m³. */}
        <KpiCard label={t("exec.cbmOcc")} value={netV === null ? "—" : f.pct(netV)} tone={tone(netV)}
          sub={`${f.cbm(vOcc)} / ${f.cbm(vCap)} m³ · ${t("heat.cbmEffective")}`} />
        <KpiCard label={t("exec.binOcc")} value={f.pct(netBin)} tone={tone(netBin)}
          sub={`${f.num(slocFilled)} / ${f.num(slocTotal)} ${t("common.sloc").toLowerCase()}`} />
        <KpiCard label={t("exec.activeAlerts")} value={f.num(totalActive)}
          tone={worstSev ? SEVERITY_TONE[worstSev] : "normal"}
          sub={worstSev ? worstSev : t("common.none")} />
        <KpiCard label={t("exec.integrity")} value={integrityAvg === null ? "—" : f.pct(integrityAvg)}
          tone={integrityAvg !== null && integrityAvg < 95 ? "warning" : "teal"}
          sub={`${sums.length} ${t("common.warehouse").toLowerCase()}`} />
      </div>

      <div className="context-note">
        <span><b style={{ color: "var(--text)" }}>{t("exec.scope")}:</b> {t("exec.scopeDetail")}</span>
        <span className="num">{f.num(unzonedActive)} {t("exec.unzoned")} · {f.num(unmappedStock)} {t("exec.unmappedStock")}</span>
      </div>

      <Section eyebrow={`${t("basis.label")}: ${t(`basis.${mode}`)}`} title={t("exec.byWarehouse")}>
        <WarehouseOverviewTable rows={sums} mode={mode} thresholds={thresholdMap} />
      </Section>

      <div className="secondary-grid">
        <Section eyebrow={`${sums.length} ${t("common.warehouse").toLowerCase()}`} title={t("exec.netOccupancy")}>
          <div className="list-rows">
            {topRisk.map((w) => (
              <PrefetchLink key={w.code} href={`/occupancy/${w.code}`} className="list-row">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="num text-sm font-semibold">{w.code}</span>
                    <StatusBadge status={w.status} />
                  </div>
                  <div className="truncate text-[11.5px]" style={{ color: "var(--text-muted)" }}>
                    {f.num(w.sloc_occupied)}/{f.num(w.sloc_total)} {t("common.filled").toLowerCase()}
                  </div>
                </div>
                <div className="text-right">
                  <div className="num text-base font-semibold">{w.pct}%</div>
                  <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    {f.hours(w.hours_to_95)}
                  </div>
                </div>
              </PrefetchLink>
            ))}
          </div>
        </Section>

        <Section eyebrow={`${totalActive} ${t("common.total").toLowerCase()}`} title={t("exec.activeAlerts")}
          action={<Link className="btn btn-ghost btn-sm" href="/alerts" prefetch={false}>{t("action.detail")}</Link>}>
          {active.length === 0 ? (
            <p className="py-4 text-center text-xs" style={{ color: "var(--text-muted)" }}>
              {t("common.none")}
            </p>
          ) : (
            <ul className="list-rows">
              {active.map((a) => (
                <li key={a.alert_id}>
                  <PrefetchLink href={`/alerts?id=${a.alert_id}`} className="list-row">
                    <div className="min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[12.5px] font-semibold">{a.rule_name}</span>
                        <SeverityBadge severity={a.severity} />
                      </div>
                      <div className="truncate text-[11.5px]" style={{ color: "var(--text-muted)" }}>
                        {a.warehouse_code}{a.sloc_code ? ` · ${a.sloc_code}` : ""} · {f.dateTime(a.created_at)}
                      </div>
                    </div>
                  </PrefetchLink>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section eyebrow={t("exec.trendEyebrow")} title={t("exec.trend")}>
        <TrendChart points={trend} height={240} />
      </Section>
    </div>
  );
}
