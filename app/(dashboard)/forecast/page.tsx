import { getForecastRows } from "@/lib/queries";
import { getLang, getT } from "@/lib/i18n";
import { formatters, type Formatters } from "@/lib/utils";
import Section from "@/components/ui/section";
import WhatIfPanel from "@/components/domain/what-if-panel";
import PageHeader from "@/components/ui/page-header";
import ExportExcelButton from "@/components/domain/export-excel-button";
import { pageTitle } from "@/lib/page-metadata";

export const dynamic = "force-dynamic";
export const generateMetadata = pageTitle("nav.forecast");

/** Laju selalu ditulis bertanda: "+0,4" dan "-0,4" harus terbaca berbeda sekilas. */
const signed = (f: Formatters, value: number, digits = 1) =>
  `${value >= 0 ? "+" : ""}${f.num(value, digits)}`;

export default async function ForecastPage() {
  const [rows, t, lang] = await Promise.all([getForecastRows(), getT(), getLang()]);
  const f = formatters(lang);
  const sorted = [...rows].sort((a, b) => (a.hours_to_95 ?? 1e9) - (b.hours_to_95 ?? 1e9));
  return (
    <div className="dashboard-page">
      <PageHeader eyebrow={t("fc.method")} title={t("fc.title")}
        actions={<ExportExcelButton dataset="forecast" />} />
      <Section eyebrow={t("fc.method")} title={t("fc.horizon")}>
        <div className="forecast-table-wrap">
          <table className="tbl forecast-table">
            <thead>
              <tr>
                <th>{t("common.warehouse")}</th>
                <th className="text-right">{t("common.occupancy")}</th>
                <th className="text-right">Bin</th>
                <th className="text-right">{t("fc.rate")}</th>
                <th className="text-right">{t("fc.rateQty")}</th>
                <th className="text-right">{t("fc.rateSku")}</th>
                <th className="text-right">{t("fc.rateBin")}</th>
                <th>{t("fc.to95")}</th><th>{t("fc.to100")}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.warehouse}>
                  <td>
                    <span className="num font-semibold">{r.warehouse}</span>
                    <span className="ml-2 text-[10.5px]" style={{ color: "var(--text-muted)" }}>{r.name}</span>
                    <span className="chip ml-2" style={{ fontSize: 9 }}>{r.basis.toUpperCase()}</span>
                    {!r.forecast_ready && <span className="chip ml-1" style={{ fontSize: 9 }}>{t("fc.awaitingHistory")}</span>}
                  </td>
                  <td className="num text-right font-semibold">{r.current_pct}%</td>
                  <td className="num text-right" title={`${r.bins_now}/${r.sloc_total}`}>
                    {f.pct(r.sloc_total ? (r.bins_now / r.sloc_total) * 100 : 0)}
                  </td>
                  <td className="num text-right">{r.forecast_ready ? `${signed(f, r.rate_pct_per_hour, 3)}%` : "—"}</td>
                  <td className="num text-right" title={`${f.num(r.qty_now)} ${t("common.unit")}`}>
                    {r.forecast_ready ? signed(f, r.qty_rate_per_hour) : "—"}
                  </td>
                  <td className="num text-right" title={`${f.num(r.sku_now)} SKU`}>
                    {r.forecast_ready ? signed(f, r.sku_rate_per_hour) : "—"}
                  </td>
                  <td className="num text-right" title={`${r.bins_now} ${t("common.filled").toLowerCase()}`}>
                    {r.forecast_ready ? signed(f, r.bin_rate_per_hour, 2) : "—"}
                  </td>
                  <td>
                    <span className="chip num" style={r.hours_to_95 !== null && r.hours_to_95 < 12
                      ? { borderColor: "var(--st-critical-fg)", color: "var(--st-critical-fg)", background: "var(--st-critical-bg)" }
                      : undefined}>
                      {f.hours(r.hours_to_95)}
                    </span>
                  </td>
                  <td><span className="chip num">{f.hours(r.hours_to_100)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section eyebrow={t("basis.binHint")} title={t("fc.simulator")}>
        <WhatIfPanel rows={rows} />
      </Section>
    </div>
  );
}
