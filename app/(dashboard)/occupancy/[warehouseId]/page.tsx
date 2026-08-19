import Link from "next/link";
import { notFound } from "next/navigation";
import { getWarehouseSummaries, getZoneSummary, getRecentMovements } from "@/lib/queries";
import { thresholdsFor } from "@/lib/config";
import { getBasisMode, pickPct, pickStatus } from "@/lib/basis";
import { fmtCbm, fmtNum, fmtPct, fmtHours, fmtDateTime } from "@/lib/utils";
import { getT } from "@/lib/i18n";
import Section from "@/components/ui/section";
import KpiCard from "@/components/ui/kpi-card";
import { StatusBadge } from "@/components/ui/badges";
import OccupancyZoneBrowser from "@/components/domain/occupancy-zone-browser";
import SlocExplorer from "@/components/domain/sloc-explorer";
import ExportExcelButton from "@/components/domain/export-excel-button";
import PageHeader from "@/components/ui/page-header";
import CapacityStandardNote from "@/components/domain/capacity-standard-note";
import { STATUS_TONE } from "@/lib/status-tone";

export const dynamic = "force-dynamic";

export async function generateMetadata(
  { params }: { params: Promise<{ warehouseId: string }> },
) {
  const { warehouseId } = await params;
  return { title: warehouseId.toUpperCase() };
}

export default async function WarehouseDetail(
  { params }: { params: Promise<{ warehouseId: string }> }
) {
  const { warehouseId } = await params;
  const code = warehouseId.toUpperCase();
  const [mode, tr, sums, zones, moves] = await Promise.all([
    getBasisMode(), getT(), getWarehouseSummaries(), getZoneSummary(code),
    getRecentMovements(undefined, 10, code),
  ]);
  const w = sums.find((s) => s.code === code);
  if (!w) notFound();
  const t = thresholdsFor(code);
  const raw = pickPct(w, mode);
  const shownStatus = raw === null ? null : pickStatus(w, mode);

  return (
    <div className="dashboard-page">
      <PageHeader
        eyebrow={`${tr("common.warehouse")} · ${tr("basis.label")} ${tr(`basis.${mode}`)}`}
        title={`${w.code} — ${w.name}`}
        actions={
          <>
          {shownStatus && <StatusBadge status={shownStatus} />}
          <ExportExcelButton dataset="sloc" params={{ wh: w.code, view: mode }}
            label={`${tr("export.excel")} · SLOC`} title={tr("export.fullHint")} />
          <Link className="btn btn-sm" href={`/heatmap?wh=${w.code}`}>{tr("heat.title")}</Link>
          <Link className="btn btn-ghost btn-sm" href="/occupancy">← {tr("common.allWarehouses")}</Link>
          </>
        }
      />

      <div className="metric-strip metric-strip-four">
        <KpiCard label={tr("common.occupancy")} value={fmtPct(raw)}
          tone={shownStatus === null ? undefined : STATUS_TONE[shownStatus]}
          sub={`${tr("occ.thresholdLadder")} ${t.monitor}/${t.warning}/${t.critical}/${t.breach}`} />
        <KpiCard label={tr("occ.slocOccupied")} value={fmtNum(w.sloc_occupied)} tone="accent"
          sub={`${fmtPct(w.pct_bin)} · ${fmtNum(w.sloc_total)} ${tr("common.active")}`} />
        <KpiCard label={tr("occ.emptySloc")} value={fmtNum(w.sloc_empty)}
          sub={`${fmtPct(100 - w.pct_bin)} ${tr("common.empty").toLowerCase()}`} />
        <KpiCard label={tr("fc.to95")} value={fmtHours(w.hours_to_95)}
          tone={w.hours_to_95 !== null && w.hours_to_95 < 12 ? "critical" : "accent"}
          sub={`${tr("fc.rate")} ${w.rate_pct_per_hour >= 0 ? "+" : ""}${fmtNum(w.rate_pct_per_hour, 3)}${tr("fc.ratePerHour")}`} />
      </div>

      <div className="occ-basis-strip card">
        <div>
          <span className="eyebrow">Qty</span>
          <strong className="num">{fmtPct(w.pct_qty)}</strong>
          <small>{fmtNum(w.occ_qty)} / {fmtNum(w.cap_qty)} {tr("common.unit")}</small>
        </div>
        {/* Angka mentah tanpa pemformat pernah tampil di sini sebagai
            "1234.5678901" — satu-satunya kolom di aplikasi yang tidak
            mengikuti format lokal. */}
        <div>
          <span className="eyebrow">{tr("heat.cbmEffective")}</span>
          <strong className="num">{fmtPct(w.pct_cbm)}</strong>
          <small title={tr("heat.capCbmHint")}>{fmtCbm(w.occ_cbm)} / {fmtCbm(w.cap_cbm)} m³</small>
        </div>
        <div>
          <span className="eyebrow">Bin</span>
          <strong className="num">{fmtPct(w.pct_bin)}</strong>
          <small>{fmtNum(w.sloc_occupied)} / {fmtNum(w.sloc_total)} SLOC</small>
        </div>
      </div>

      <CapacityStandardNote warehouse={code} />

      <Section eyebrow={`${zones.length} ${tr("common.zone").toLowerCase()} · ${tr("occ.zoneHint")}`} title={tr("occ.byZone")}>
        <OccupancyZoneBrowser rows={zones} mode={mode} thresholds={{ [code]: t }} fixedWarehouse={code} />
      </Section>

      <Section eyebrow={`${tr("slocx.warehouseScope")} · ${tr("slocx.hint")}`} title={tr("slocx.title")}>
        <SlocExplorer lockedWh={code} initialView={mode} storageKey="warehouse" />
      </Section>

      <Section eyebrow={`${code} · 10 ${tr("occ.rows")}`} title={tr("occ.movements")}>
        <div className="occ-movement-wrap">
          <table className="tbl">
            <thead>
              <tr><th>{tr("common.time")}</th><th>{tr("common.type")}</th><th>{tr("common.product")}</th><th>{tr("common.from")}</th><th>{tr("common.to")}</th><th className="text-right">Qty</th><th>{tr("common.operator")}</th></tr>
            </thead>
            <tbody>
              {(moves as Array<Record<string, unknown>>).map((m) => (
                <tr key={String(m.movement_id)}>
                  <td className="num">{fmtDateTime(String(m.at))}</td>
                  <td><span className="chip">{String(m.movement_type)}</span></td>
                  <td className="max-w-[220px] truncate">{String(m.product_name ?? "—")}</td>
                  <td className="num">{String(m.source_sloc ?? "—")}</td>
                  <td className="num">{String(m.destination_sloc ?? "—")}</td>
                  <td className="num text-right">{String(m.qty)}</td>
                  <td>{String(m.operator)}</td>
                </tr>
              ))}
              {moves.length === 0 && (
                <tr><td colSpan={7} className="py-8 text-center text-xs" style={{ color: "var(--text-muted)" }}>{tr("common.none")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
