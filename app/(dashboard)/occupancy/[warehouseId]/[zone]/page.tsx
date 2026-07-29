import Link from "next/link";
import { notFound } from "next/navigation";
import { getZoneSummary, getZoneDetail } from "@/lib/queries";
import { getBasisMode, pickPct, pickStatus } from "@/lib/basis";
import { fmtNum, fmtPct, fmtCbm } from "@/lib/utils";
import { getT } from "@/lib/i18n";
import Section from "@/components/ui/section";
import KpiCard from "@/components/ui/kpi-card";
import { StatusBadge } from "@/components/ui/badges";
import CsvButton from "@/components/domain/csv-button";
import ZoneDetailTable from "@/components/domain/zone-detail-table";
import type { OccupancyStatus } from "@/types";
import PageHeader from "@/components/ui/page-header";

export const dynamic = "force-dynamic";

const stColor: Record<string, string> = {
  NORMAL: "var(--st-normal-fg)", MONITOR: "var(--st-monitor-fg)",
  WARNING: "var(--st-warning-fg)", CRITICAL: "var(--st-critical-fg)", BREACH: "var(--st-critical-fg)",
};

function toneFor(status: OccupancyStatus | null) {
  if (status === "NORMAL") return "normal" as const;
  if (status === "MONITOR") return "monitor" as const;
  if (status === "WARNING") return "warning" as const;
  if (status === "CRITICAL" || status === "BREACH") return "critical" as const;
  return undefined;
}

export default async function ZoneDetailPage(
  { params }: { params: Promise<{ warehouseId: string; zone: string }> }
) {
  const p = await params;
  const code = p.warehouseId.toUpperCase();
  const zone = decodeURIComponent(p.zone).toUpperCase();
  const [mode, t, zones, detail] = await Promise.all([
    getBasisMode(), getT(),
    getZoneSummary(code), getZoneDetail(code, zone),
  ]);
  const lines = detail.rows;
  const z = zones.find((x) => x.zone === zone);
  if (!z) notFound();
  const shownPct = pickPct(z, mode);
  const shownStatus = shownPct === null ? null : pickStatus(z, mode);

  const csvRows = lines.map((l) => ({
    lokasi: l.sloc_code, rack_zone: l.rack_zone, no_sku: l.sku_number, nama_sku: l.product_name,
    kategori: l.l1_category, status: l.status, qty: l.qty, cbm: l.cbm,
    okupansi_sloc_pct: l.sloc_pct, basis: l.sloc_basis,
  }));

  return (
    <div className="dashboard-page">
      <PageHeader
        eyebrow={`${code} · ${t("common.zone")} ${zone} · ${z.storage}`}
        title={t("occ.zoneContents")}
        actions={
          <>
          <span className="chip">{t("basis.label")}: {t(`basis.${mode}`)}</span>
          {shownStatus && <StatusBadge status={shownStatus} />}
          <Link className="btn btn-sm" href={`/heatmap?wh=${code}`}>{t("heat.title")}</Link>
          <Link className="btn btn-ghost btn-sm" href={`/occupancy/${code}`}>← {t("action.back")}</Link>
          </>
        }
      />

      <div className="metric-strip metric-strip-four">
        <KpiCard
          label={t("common.occupancy")}
          value={fmtPct(shownPct)}
          tone={toneFor(shownStatus)}
          sub={`${t("basis.label")}: ${t(`basis.${mode}`)}`}
        />
        <KpiCard
          label={t("occ.slocOccupied")}
          value={fmtNum(z.sloc_occupied)}
          sub={`${fmtPct(z.pct_bin)} · ${fmtNum(z.sloc_total)} ${t("common.active")}`}
          tone="accent"
        />
        <KpiCard
          label={t("occ.emptySloc")}
          value={fmtNum(z.sloc_empty)}
          sub={`${fmtPct(100 - z.pct_bin)} ${t("common.empty").toLocaleLowerCase()}`}
        />
        <KpiCard
          label={`${t("common.sku")} · ${t("occ.rows")}`}
          value={fmtNum(detail.total)}
          sub={detail.truncated
            ? `${fmtNum(lines.length)} ${t("occ.rowsLoaded")}`
            : t("occ.zoneContents")}
          tone="accent"
        />
      </div>

      <div className="occ-basis-strip card">
        <div>
          <span className="eyebrow">Qty</span>
          <strong className="num">{fmtPct(z.pct_qty)}</strong>
          <small>{fmtNum(z.occ_qty)} / {fmtNum(z.cap_qty)} {t("common.unit")}</small>
        </div>
        <div>
          <span className="eyebrow">CBM</span>
          <strong className="num">{fmtPct(z.pct_cbm)}</strong>
          <small>{fmtCbm(z.occ_cbm)} / {fmtCbm(z.cap_cbm)} m³</small>
        </div>
        <div>
          <span className="eyebrow">Bin</span>
          <strong className="num">{fmtPct(z.pct_bin)}</strong>
          <small>{fmtNum(z.sloc_occupied)} / {fmtNum(z.sloc_total)} SLOC</small>
        </div>
      </div>

      <Section
        eyebrow={`${fmtNum(lines.length)} ${t("common.of")} ${fmtNum(detail.total)} ${t("occ.rows")} · ${code}/${zone}`}
        title={t("occ.zoneContents")}
        action={
          <CsvButton
            rows={csvRows}
            filename={`wiom-${code}-${zone}${detail.truncated ? "-loaded" : ""}.csv`}
            label={detail.truncated ? `${t("action.export")} (${fmtNum(lines.length)})` : t("action.export")}
          />
        }
      >
        <ZoneDetailTable
          rows={lines}
          total={detail.total}
          warehouse={code}
          zone={zone}
          statusColor={stColor}
        />
      </Section>
    </div>
  );
}
