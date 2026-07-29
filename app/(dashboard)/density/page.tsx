import Link from "next/link";
import { getDenseSlocs, getWarehouseSummaries } from "@/lib/queries";
import { getBasisMode } from "@/lib/basis";
import { getT } from "@/lib/i18n";
import { fmtNum, fmtPct } from "@/lib/utils";
import Section from "@/components/ui/section";
import KpiCard from "@/components/ui/kpi-card";
import DensityTable from "@/components/domain/density-table";
import PageHeader from "@/components/ui/page-header";

export const dynamic = "force-dynamic";

export default async function DensityPage(
  { searchParams }: { searchParams: Promise<{ wh?: string; min?: string }> }
) {
  const { wh, min } = await searchParams;
  const [t, mode] = await Promise.all([getT(), getBasisMode()]);
  const sums = await getWarehouseSummaries();
  const codes = sums.map((s) => s.code);
  const whSel = wh && codes.includes(wh.toUpperCase()) ? wh.toUpperCase() : undefined;
  const minPct = Number(min) > 0 ? Number(min) : 90;

  const rows = await getDenseSlocs(whSel, minPct, 300, mode);
  const over = rows.filter((r) => r.pct >= 100).length;
  const near = rows.filter((r) => r.pct >= 90 && r.pct < 100).length;
  const scope = sums.filter((s) => !whSel || s.code === whSel);
  const totalSloc = scope.reduce((s, w) => s + w.sloc_total, 0);
  const filled = scope.reduce((s, w) => s + w.sloc_occupied, 0);

  return (
    <div className="dashboard-page">
      <PageHeader eyebrow={t("dens.subtitle")} title={t("dens.title")} />
      <form className="context-bar">
        <select className="input w-auto" name="wh" defaultValue={whSel ?? ""} aria-label={t("common.warehouse")}>
          <option value="">{t("common.allWarehouses")}</option>
          {codes.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select className="input w-auto" name="min" defaultValue={String(minPct)} aria-label={t("dens.threshold")}>
          {[70, 80, 90, 100].map((v) => <option key={v} value={v}>≥ {v}%</option>)}
        </select>
        <button className="btn btn-sm">{t("action.apply")}</button>
        {(whSel || minPct !== 90) && <Link className="btn btn-ghost btn-sm" href="/density">{t("action.reset")}</Link>}
      </form>

      <div className="metric-strip metric-strip-four">
        <KpiCard label={t("dens.overCap")} value={fmtNum(over)} tone={over ? "critical" : "normal"}
          sub={t("common.sloc").toLowerCase()} />
        <KpiCard label={t("dens.near")} value={fmtNum(near)} tone={near ? "warning" : "normal"}
          sub={t("common.sloc").toLowerCase()} />
        <KpiCard label={t("occ.slocOccupied")} value={fmtNum(filled)} tone="accent"
          sub={`${t("common.of")} ${fmtNum(totalSloc)} ${t("common.active")}`} />
        <KpiCard label="Bin" value={fmtPct(totalSloc ? (filled / totalSloc) * 100 : 0)} tone="teal"
          sub={t("basis.binHint")} />
      </div>

      <Section eyebrow={`${t(`basis.${mode}`)} · ${rows.length} ${t("occ.rows")} · ${t("dens.clickDetail")}`}
        title={`${t("dens.subtitle")}${whSel ? ` · ${whSel}` : ""}`}>
        <DensityTable rows={rows} />
      </Section>
    </div>
  );
}
