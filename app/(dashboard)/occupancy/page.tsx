import { getWarehouseOccupancySummary, getZoneSummary } from "@/lib/queries";
import { thresholdsFor } from "@/lib/config";
import { getBasisMode, pickPct, pickStatus } from "@/lib/basis";
import { fmtNum, fmtPct } from "@/lib/utils";
import { getT } from "@/lib/i18n";
import Section from "@/components/ui/section";
import OccupancyBar from "@/components/ui/occupancy-bar";
import { StatusBadge } from "@/components/ui/badges";
import OccupancyZoneBrowser from "@/components/domain/occupancy-zone-browser";
import SlocExplorer from "@/components/domain/sloc-explorer";
import ExportExcelButton from "@/components/domain/export-excel-button";
import PageHeader from "@/components/ui/page-header";
import PrefetchLink from "@/components/ui/prefetch-link";
import CapacityStandardNote from "@/components/domain/capacity-standard-note";
import { pageTitle } from "@/lib/page-metadata";

export const dynamic = "force-dynamic";
export const generateMetadata = pageTitle("nav.occupancy");

export default async function OccupancyPage() {
  const [mode, t] = await Promise.all([getBasisMode(), getT()]);
  const [sums, zones] = await Promise.all([getWarehouseOccupancySummary(), getZoneSummary()]);
  const thresholdMap = Object.fromEntries(sums.map((w) => [w.code, thresholdsFor(w.code)]));
  const totalActive = sums.reduce((sum, warehouse) => sum + warehouse.sloc_total, 0);
  const totalOccupied = sums.reduce((sum, warehouse) => sum + warehouse.sloc_occupied, 0);
  const totalEmpty = sums.reduce((sum, warehouse) => sum + warehouse.sloc_empty, 0);
  const attention = sums.filter(
    (warehouse) => pickPct(warehouse, mode) !== null && pickStatus(warehouse, mode) !== "NORMAL",
  ).length;

  return (
    <div className="dashboard-page">
      <PageHeader
        eyebrow={t("occ.networkScope")}
        title={t("occ.title")}
        actions={
          <>
            <span className="chip chip-accent">{t("basis.label")}: {t(`basis.${mode}`)}</span>
            <ExportExcelButton dataset="warehouse" params={{ view: mode }}
              label={`${t("export.excel")} · ${t("common.warehouse")}`} />
          </>
        }
      />

      <CapacityStandardNote />

      <div className="occ-summary-strip">
        <div className="occ-summary-item"><span className="eyebrow">{t("occ.activeSloc")}</span><strong className="num">{fmtNum(totalActive)}</strong><span>{sums.length} {t("common.warehouse").toLowerCase()}</span></div>
        <div className="occ-summary-item"><span className="eyebrow">{t("occ.slocOccupied")}</span><strong className="num">{fmtNum(totalOccupied)}</strong><span>{totalActive ? fmtPct(totalOccupied / totalActive * 100) : "0%"}</span></div>
        <div className="occ-summary-item"><span className="eyebrow">{t("occ.emptySloc")}</span><strong className="num">{fmtNum(totalEmpty)}</strong><span>{totalActive ? fmtPct(totalEmpty / totalActive * 100) : "0%"}</span></div>
        <div className="occ-summary-item occ-summary-alert"><span className="eyebrow">{t("occ.attentionWarehouses")}</span><strong className="num">{attention}</strong><span>{sums.length} {t("common.total").toLowerCase()}</span></div>
      </div>

      <Section eyebrow={`${sums.length} ${t("common.warehouse").toLowerCase()}`} title={t("exec.byWarehouse")} variant="plain">
        <div className="occ-warehouse-grid">
        {sums.map((w) => {
          const raw = pickPct(w, mode);
          const shownStatus = raw === null ? null : pickStatus(w, mode);
          return (
            <PrefetchLink key={w.code} href={`/occupancy/${w.code}`} className="occ-warehouse-card">
              <div className="occ-warehouse-head">
                <div className="min-w-0">
                  <strong className="num">{w.code}</strong>
                  <span title={w.name}>{w.name}</span>
                </div>
                {shownStatus ? <StatusBadge status={shownStatus} /> : <span className="chip">N/A</span>}
              </div>
              <div className="occ-warehouse-primary">
                <strong className="num">{raw === null ? "—" : `${raw}%`}</strong>
                <span>{t(`basis.${mode}`)}</span>
              </div>
              {raw === null || shownStatus === null
                ? <span className="occ-track-unavailable" title={t("heat.unavailable")} />
                : <OccupancyBar pct={raw} status={shownStatus} thresholds={thresholdsFor(w.code)}
                    label={`${t("common.occupancy")} ${w.code}`} />}
              <div className="occ-warehouse-metrics">
                <span>Qty <b className="num">{fmtPct(w.pct_qty)}</b></span>
                <span>CBM <b className="num">{fmtPct(w.pct_cbm)}</b></span>
                <span>Bin <b className="num">{fmtPct(w.pct_bin)}</b></span>
              </div>
              <div className="occ-warehouse-foot">
                <span>{t("common.empty")} <b className="num">{fmtNum(w.sloc_empty)}</b></span>
                <span>{t("common.total")} <b className="num">{fmtNum(w.sloc_total)}</b></span>
              </div>
            </PrefetchLink>
          );
        })}
        </div>
      </Section>

      <Section eyebrow={`${t("basis.label")}: ${t(`basis.${mode}`)} · ${t("occ.zoneHint")}`} title={t("occ.byZone")}>
        <OccupancyZoneBrowser rows={zones} mode={mode} thresholds={thresholdMap} />
      </Section>

      {/* Ringkasan zona menjawab "zona mana", penjelajah menjawab "lokasi mana"
          — termasuk lokasi kosong, yang tidak pernah muncul pada tabel isi zona
          karena lokasi kosong memang tidak punya baris stok. */}
      <Section eyebrow={t("slocx.hint")} title={t("slocx.title")}>
        <SlocExplorer initialView={mode} storageKey="occupancy" />
      </Section>
    </div>
  );
}
