import Link from "next/link";
import { notFound } from "next/navigation";
import { getWarehouseSummaries, getZoneSummary } from "@/lib/queries";
import { thresholdsFor } from "@/lib/config";
import { getBasisMode, pickPct, pickStatus } from "@/lib/basis";
import { formatters } from "@/lib/utils";
import { getLang, getT } from "@/lib/i18n";
import Section from "@/components/ui/section";
import KpiCard from "@/components/ui/kpi-card";
import { StatusBadge } from "@/components/ui/badges";
import OccupancyZoneBrowser from "@/components/domain/occupancy-zone-browser";
import SlocExplorer from "@/components/domain/sloc-explorer";
import MovementExplorer from "@/components/domain/movement-explorer";
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
  const [mode, tr, lang, sums, zones] = await Promise.all([
    getBasisMode(), getT(), getLang(), getWarehouseSummaries(), getZoneSummary(code),
  ]);
  const f = formatters(lang);
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
        <KpiCard label={tr("common.occupancy")} value={f.pct(raw)}
          tone={shownStatus === null ? undefined : STATUS_TONE[shownStatus]}
          sub={`${tr("occ.thresholdLadder")} ${t.monitor}/${t.warning}/${t.critical}/${t.breach}`} />
        <KpiCard label={tr("occ.slocOccupied")} value={f.num(w.sloc_occupied)} tone="accent"
          sub={`${f.pct(w.pct_bin)} · ${f.num(w.sloc_total)} ${tr("common.active")}`} />
        <KpiCard label={tr("occ.emptySloc")} value={f.num(w.sloc_empty)}
          sub={`${f.pct(100 - w.pct_bin)} ${tr("common.empty").toLowerCase()}`} />
        <KpiCard label={tr("fc.to95")} value={f.hours(w.hours_to_95)}
          tone={w.hours_to_95 !== null && w.hours_to_95 < 12 ? "critical" : "accent"}
          sub={`${tr("fc.rate")} ${w.rate_pct_per_hour >= 0 ? "+" : ""}${f.num(w.rate_pct_per_hour, 3)}${tr("fc.ratePerHour")}`} />
      </div>

      <div className="occ-basis-strip card">
        <div>
          <span className="eyebrow">Qty</span>
          <strong className="num">{f.pct(w.pct_qty)}</strong>
          <small>{f.num(w.occ_qty)} / {f.num(w.cap_qty)} {tr("common.unit")}</small>
        </div>
        {/* Angka mentah tanpa pemformat pernah tampil di sini sebagai
            "1234.5678901" — satu-satunya kolom di aplikasi yang tidak
            mengikuti format lokal. */}
        <div>
          <span className="eyebrow">{tr("heat.cbmEffective")}</span>
          <strong className="num">{f.pct(w.pct_cbm)}</strong>
          <small title={tr("heat.capCbmHint")}>{f.cbm(w.occ_cbm)} / {f.cbm(w.cap_cbm)} m³</small>
        </div>
        <div>
          <span className="eyebrow">Bin</span>
          <strong className="num">{f.pct(w.pct_bin)}</strong>
          <small>{f.num(w.sloc_occupied)} / {f.num(w.sloc_total)} SLOC</small>
        </div>
      </div>

      <CapacityStandardNote warehouse={code} />

      <Section eyebrow={`${zones.length} ${tr("common.zone").toLowerCase()} · ${tr("occ.zoneHint")}`} title={tr("occ.byZone")}>
        <OccupancyZoneBrowser rows={zones} mode={mode} thresholds={{ [code]: t }} fixedWarehouse={code} />
      </Section>

      <Section eyebrow={`${tr("slocx.warehouseScope")} · ${tr("slocx.hint")}`} title={tr("slocx.title")}>
        <SlocExplorer lockedWh={code} initialView={mode} storageKey="warehouse" />
      </Section>

      {/* Pergerakan gudang ini memakai penjelajah yang sama dengan halaman
          Pergerakan, hanya terkunci pada satu gudang. Sebelumnya tempat ini
          diisi sepuluh baris statis tanpa filter — cukup untuk memastikan data
          mengalir, tidak cukup untuk menjawab satu pun pertanyaan tentangnya. */}
      <Section
        eyebrow={`${code} · ${tr("mv.tableHint")}`}
        title={tr("occ.movements")}
        action={
          <Link className="btn btn-ghost btn-sm" href={`/movements?wh=${code}`}>
            {tr("mv.openFull")} →
          </Link>
        }
      >
        <MovementExplorer lockedWh={code} storageKey="warehouse-movements" />
      </Section>
    </div>
  );
}
