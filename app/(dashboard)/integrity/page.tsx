import Link from "next/link";
import { getIntegrity, getIntegrityDrift, getSyncHealth } from "@/lib/queries";
import { getWarehouses } from "@/lib/config";
import { getLang, getT, localeOf } from "@/lib/i18n";
import Section from "@/components/ui/section";
import KpiCard from "@/components/ui/kpi-card";
import PageHeader from "@/components/ui/page-header";

export const dynamic = "force-dynamic";

function formatNumber(value: number | null | undefined, locale: string, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatPercent(value: number | null | undefined, locale: string, digits = 1) {
  return value === null || value === undefined || Number.isNaN(value)
    ? "—"
    : `${formatNumber(value, locale, digits)}%`;
}

function formatDateTime(value: string | null | undefined, locale: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Jakarta",
  }).format(date)} WIB`;
}

function formatDate(value: unknown, locale: string) {
  const raw = String(value ?? "");
  if (!raw) return "—";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(date);
}

export default async function IntegrityPage(
  { searchParams }: { searchParams: Promise<{ wh?: string }> }
) {
  const { wh } = await searchParams;
  const whList = getWarehouses().warehouses.map((warehouse) => warehouse.code);
  const whSel = wh && whList.includes(wh.toUpperCase()) ? wh.toUpperCase() : undefined;

  const [rows, drift, sync, t, lang] = await Promise.all([
    getIntegrity(whSel),
    getIntegrityDrift(30, whSel),
    getSyncHealth(),
    getT(),
    getLang(),
  ]);
  const locale = localeOf(lang);
  const counted = rows.reduce((sum, row) => sum + row.counted, 0);
  const matched = rows.reduce((sum, row) => sum + row.matched, 0);
  const average = counted ? (matched / counted) * 100 : null;
  const phantom = rows.reduce((sum, row) => sum + row.phantom, 0);
  const ghost = rows.reduce((sum, row) => sum + row.ghost, 0);

  return (
    <div className="dashboard-page">
      <PageHeader
        eyebrow={t("int.ui.header.eyebrow")}
        title={t("int.title")}
        description={t("int.ui.header.description")}
      />

      <div className="context-bar">
        <form className="flex flex-wrap items-center gap-2">
          <select
            className="input w-auto"
            name="wh"
            defaultValue={whSel ?? ""}
            aria-label={t("int.ui.filterWarehouse")}
          >
            <option value="">{t("common.allWarehouses")}</option>
            {whList.map((warehouse) => <option key={warehouse}>{warehouse}</option>)}
          </select>
          <button className="btn btn-sm">{t("action.apply")}</button>
          {whSel && <Link className="btn btn-ghost btn-sm" href="/integrity">{t("action.reset")}</Link>}
        </form>
        <span className="chip" title={t("int.ui.snapshotTitle")}>
          {t("int.ui.snapshot")} {formatDateTime(sync.last_snapshot, locale)}
        </span>
      </div>

      <div className="metric-strip metric-strip-four">
        <KpiCard
          label={`${t("int.title")} ${whSel ?? t("int.ui.network")}`}
          value={formatPercent(average, locale)}
          tone={average !== null && average < 95 ? "warning" : "teal"}
          sub={`${formatNumber(matched, locale)}/${formatNumber(counted, locale)} ${t("int.ui.slocMatch")}`}
        />
        <KpiCard
          label={t("int.ui.phantomOccupancy")}
          value={formatNumber(phantom, locale)}
          tone={phantom ? "critical" : "normal"}
          sub={t("int.ui.phantomSub")}
        />
        <KpiCard
          label={t("int.ui.ghostStock")}
          value={formatNumber(ghost, locale)}
          tone={ghost ? "warning" : "normal"}
          sub={t("int.ui.ghostSub")}
        />
        <KpiCard
          label={t("int.ui.countedSloc")}
          value={formatNumber(counted, locale)}
          tone="accent"
          sub={whSel ? `${t("int.ui.cycleCount")} ${whSel}` : t("int.ui.allWarehousesSub")}
        />
      </div>

      <div className="card card-pad text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        <span className="panel-title block pb-1" style={{ color: "var(--text)" }}>
          {t("int.ui.howToRead")}
        </span>
        {t("int.ui.explanation")}
      </div>

      <Section eyebrow={t("int.ui.byWarehouseEyebrow")} title={t("int.ui.byWarehouseTitle")}>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("common.warehouse")}</th>
                <th className="text-right">{t("int.ui.countedSloc")}</th>
                <th className="text-right">{t("int.ui.matched")}</th>
                <th className="text-right">{t("int.title")}</th>
                <th className="text-right">{t("int.phantom")}</th>
                <th className="text-right">{t("int.ghost")}</th>
                <th>{t("int.ui.lastCycleCount")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.warehouse}>
                  <td className="num font-semibold">
                    <Link
                      href={`/integrity?wh=${row.warehouse}`}
                      prefetch={false}
                      className="underline decoration-dotted underline-offset-2"
                      style={{ color: "var(--accent)" }}
                    >
                      {row.warehouse}
                    </Link>
                  </td>
                  <td className="num text-right">{formatNumber(row.counted, locale)}</td>
                  <td className="num text-right">{formatNumber(row.matched, locale)}</td>
                  <td
                    className="num text-right font-semibold"
                    style={{ color: row.integrity_pct < 95 ? "var(--st-warning-fg)" : "var(--st-normal-fg)" }}
                  >
                    {formatPercent(row.integrity_pct, locale)}
                  </td>
                  <td
                    className="num text-right"
                    style={row.phantom ? { color: "var(--st-critical-fg)", fontWeight: 600 } : undefined}
                  >
                    {formatNumber(row.phantom, locale)}
                  </td>
                  <td
                    className="num text-right"
                    style={row.ghost ? { color: "var(--st-warning-fg)", fontWeight: 600 } : undefined}
                  >
                    {formatNumber(row.ghost, locale)}
                  </td>
                  <td className="num">{formatDate(row.last_count, locale)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-xs" style={{ color: "var(--text-muted)" }}>
                    {t("int.ui.noCycleCount")}
                    {whSel ? ` ${t("int.ui.forWarehouse")} ${whSel}` : ""}. {t("int.ui.syncCycleCount")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        eyebrow={`${t("int.ui.largestDrift")}${whSel ? ` · ${whSel}` : ""}`}
        title={t("int.ui.driftTitle")}
      >
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
              {(drift as Array<Record<string, unknown>>).map((item, index) => {
                const type = String(item.drift_type);
                return (
                  <tr key={index}>
                    <td className="num font-semibold">{String(item.warehouse)}</td>
                    <td className="num">{String(item.sloc_code)}</td>
                    <td className="num">{formatDate(item.count_date, locale)}</td>
                    <td className="num text-right">{formatNumber(Number(item.system_qty), locale)}</td>
                    <td className="num text-right">{formatNumber(Number(item.physical_qty), locale)}</td>
                    <td
                      className="num text-right font-semibold"
                      style={{ color: Number(item.diff) < 0 ? "var(--st-critical-fg)" : "var(--st-warning-fg)" }}
                    >
                      {Number(item.diff) > 0 ? "+" : ""}{formatNumber(Number(item.diff), locale)}
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          type === "PHANTOM"
                            ? "badge-critical"
                            : type === "GHOST"
                              ? "badge-warning"
                              : "badge-monitor"
                        }`}
                      >
                        {t(`int.ui.drift.${type}`, type)}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {(drift as unknown[]).length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-xs" style={{ color: "var(--text-muted)" }}>
                    {t("int.ui.noDrift")}{whSel ? ` ${t("int.ui.forWarehouse")} ${whSel}` : ""}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
          {t("int.ui.driftNote")}
        </p>
      </Section>
    </div>
  );
}
