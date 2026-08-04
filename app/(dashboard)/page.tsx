import Link from "next/link";
import { getWarehouseDashboard, getIntegrity, getOccupancyScopeQuality } from "@/lib/queries";
import { listAlerts, activeCountsBySeverity } from "@/lib/alerts/store";
import { getBasisMode } from "@/lib/basis";
import { getT } from "@/lib/i18n";
import { fmtNum, fmtPct, fmtHours, fmtDateTime } from "@/lib/utils";
import KpiCard from "@/components/ui/kpi-card";
import Section from "@/components/ui/section";
import { StatusBadge, SeverityBadge } from "@/components/ui/badges";
import TrendChart from "@/components/charts/trend-chart-lazy";
import WarehouseOverviewTable from "@/components/domain/warehouse-overview-table";
import PageHeader from "@/components/ui/page-header";

export const dynamic = "force-dynamic";

const STATUS_RANK = { BREACH: 0, CRITICAL: 1, WARNING: 2, MONITOR: 3, NORMAL: 4 } as const;

export default async function ExecutivePage() {
  const [mode, t] = await Promise.all([getBasisMode(), getT()]);
  const [warehouseData, integrity, active, counts, scopeQuality] = await Promise.all([
    getWarehouseDashboard(48),
    getIntegrity().catch(() => []),
    listAlerts({ status: ["NEW", "NOTIFIED", "ACKNOWLEDGED"], limit: 6 }),
    activeCountsBySeverity(),
    getOccupancyScopeQuality(),
  ]);
  const { summaries: sums, trend } = warehouseData;

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

  const tone = (p: number | null) =>
    p === null ? undefined : p >= 95 ? "critical" : p >= 85 ? "warning" : p >= 70 ? "monitor" : "normal";

  return (
    <div className="dashboard-page">
      <PageHeader title={t("exec.title")} />

      <div className="metric-strip metric-strip-five">
        <KpiCard label={t("exec.qtyOcc")} value={netQ === null ? "—" : fmtPct(netQ)} tone={tone(netQ)}
          sub={`${fmtNum(qOcc)} / ${fmtNum(qCap)} ${t("common.unit")}`} />
        <KpiCard label={t("exec.cbmOcc")} value={netV === null ? "—" : fmtPct(netV)} tone={tone(netV)}
          sub={`${fmtNum(vOcc)} / ${fmtNum(vCap)} m³`} />
        <KpiCard label={t("exec.binOcc")} value={fmtPct(netBin)} tone={tone(netBin)}
          sub={`${fmtNum(slocFilled)} / ${fmtNum(slocTotal)} ${t("common.sloc").toLowerCase()}`} />
        <KpiCard label={t("exec.activeAlerts")} value={fmtNum(totalActive)}
          tone={worstSev === "EMERGENCY" || worstSev === "CRITICAL" ? "critical"
            : worstSev === "HIGH" ? "warning" : totalActive ? "monitor" : "normal"}
          sub={worstSev ? worstSev : t("common.none")} />
        <KpiCard label={t("exec.integrity")} value={integrityAvg === null ? "—" : fmtPct(integrityAvg)}
          tone={integrityAvg !== null && integrityAvg < 95 ? "warning" : "teal"}
          sub={`${sums.length} ${t("common.warehouse").toLowerCase()}`} />
      </div>

      <div className="context-note">
        <span><b style={{ color: "var(--text)" }}>{t("exec.scope")}:</b> {t("exec.scopeDetail")}</span>
        <span className="num">{fmtNum(unzonedActive)} {t("exec.unzoned")} · {fmtNum(unmappedStock)} {t("exec.unmappedStock")}</span>
      </div>

      <Section eyebrow={`${t("basis.label")}: ${t(`basis.${mode}`)}`} title={t("exec.byWarehouse")}>
        <WarehouseOverviewTable rows={sums} mode={mode} />
      </Section>

      <div className="secondary-grid">
        <Section eyebrow={`${sums.length} ${t("common.warehouse").toLowerCase()}`} title={t("exec.netOccupancy")}>
          <div className="list-rows">
            {topRisk.map((w) => (
              <Link key={w.code} href={`/occupancy/${w.code}`} prefetch={false} className="list-row">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="num text-sm font-semibold">{w.code}</span>
                    <StatusBadge status={w.status} />
                  </div>
                  <div className="truncate text-[11.5px]" style={{ color: "var(--text-muted)" }}>
                    {fmtNum(w.sloc_occupied)}/{fmtNum(w.sloc_total)} {t("common.filled").toLowerCase()}
                  </div>
                </div>
                <div className="text-right">
                  <div className="num text-base font-semibold">{w.pct}%</div>
                  <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    {fmtHours(w.hours_to_95)}
                  </div>
                </div>
              </Link>
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
                  <Link href={`/alerts?id=${a.alert_id}`} prefetch={false} className="list-row">
                    <div className="min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[12.5px] font-semibold">{a.rule_name}</span>
                        <SeverityBadge severity={a.severity} />
                      </div>
                      <div className="truncate text-[11.5px]" style={{ color: "var(--text-muted)" }}>
                        {a.warehouse_code}{a.sloc_code ? ` · ${a.sloc_code}` : ""} · {fmtDateTime(a.created_at)}
                      </div>
                    </div>
                  </Link>
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
