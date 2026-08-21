import Link from "next/link";
import { getIntegrity, getIntegrityDrift, getSyncHealth } from "@/lib/queries";
import { getWarehouses } from "@/lib/config";
import { getLang, getT } from "@/lib/i18n";
// Halaman ini dulu menyalin seluruh pemformat bersama hanya untuk mendapat
// versi yang mengikuti bahasa. Pemformat bersamanya kini memang mengikuti
// bahasa, jadi salinannya hilang bersama peluang keduanya menyimpang.
import { formatters } from "@/lib/utils";
import Section from "@/components/ui/section";
import KpiCard from "@/components/ui/kpi-card";
import PageHeader from "@/components/ui/page-header";
import IntegrityDriftTable from "@/components/domain/integrity-drift-table";
import ExportExcelButton from "@/components/domain/export-excel-button";
import { pageTitle } from "@/lib/page-metadata";

export const dynamic = "force-dynamic";
export const generateMetadata = pageTitle("nav.integrity");

/**
 * Halaman memuat lebih banyak selisih daripada 30 baris lama supaya pencarian
 * di sisi klien punya bahan yang cukup; ekspor tetap mengambil ulang seluruh
 * baris yang cocok langsung dari DuckDB.
 */
const DRIFT_PAGE_ROWS = 500;

export default async function IntegrityPage(
  { searchParams }: { searchParams: Promise<{ wh?: string }> }
) {
  const { wh } = await searchParams;
  const whList = getWarehouses().warehouses.map((warehouse) => warehouse.code);
  const whSel = wh && whList.includes(wh.toUpperCase()) ? wh.toUpperCase() : undefined;

  const [rows, drift, sync, t, lang] = await Promise.all([
    getIntegrity(whSel),
    getIntegrityDrift(DRIFT_PAGE_ROWS, whSel),
    getSyncHealth(),
    getT(),
    getLang(),
  ]);
  const f = formatters(lang);
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
          {t("int.ui.snapshot")} {f.dateTime(sync.last_snapshot)}
        </span>
      </div>

      <div className="metric-strip metric-strip-four">
        <KpiCard
          label={`${t("int.title")} ${whSel ?? t("int.ui.network")}`}
          value={f.pct(average)}
          tone={average !== null && average < 95 ? "warning" : "teal"}
          sub={`${f.num(matched)}/${f.num(counted)} ${t("int.ui.slocMatch")}`}
        />
        <KpiCard
          label={t("int.ui.phantomOccupancy")}
          value={f.num(phantom)}
          tone={phantom ? "critical" : "normal"}
          sub={t("int.ui.phantomSub")}
        />
        <KpiCard
          label={t("int.ui.ghostStock")}
          value={f.num(ghost)}
          tone={ghost ? "warning" : "normal"}
          sub={t("int.ui.ghostSub")}
        />
        <KpiCard
          label={t("int.ui.countedSloc")}
          value={f.num(counted)}
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

      <Section
        eyebrow={t("int.ui.byWarehouseEyebrow")}
        title={t("int.ui.byWarehouseTitle")}
        action={<ExportExcelButton dataset="integrity" params={whSel ? { wh: whSel } : {}} />}
      >
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
                  <td className="num text-right">{f.num(row.counted)}</td>
                  <td className="num text-right">{f.num(row.matched)}</td>
                  <td
                    className="num text-right font-semibold"
                    style={{ color: row.integrity_pct < 95 ? "var(--st-warning-fg)" : "var(--st-normal-fg)" }}
                  >
                    {f.pct(row.integrity_pct)}
                  </td>
                  <td
                    className="num text-right"
                    style={row.phantom ? { color: "var(--st-critical-fg)", fontWeight: 600 } : undefined}
                  >
                    {f.num(row.phantom)}
                  </td>
                  <td
                    className="num text-right"
                    style={row.ghost ? { color: "var(--st-warning-fg)", fontWeight: 600 } : undefined}
                  >
                    {f.num(row.ghost)}
                  </td>
                  <td className="num">{f.date(row.last_count)}</td>
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
        <IntegrityDriftTable rows={drift} warehouse={whSel} loadedLimit={DRIFT_PAGE_ROWS} />
        <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
          {t("int.ui.driftNote")}
        </p>
      </Section>
    </div>
  );
}
