import { getWarehouses } from "@/lib/config";
import { getT } from "@/lib/i18n";
import HeatmapGrid from "@/components/domain/heatmap-grid";
import PageHeader from "@/components/ui/page-header";
import CapacityStandardNote from "@/components/domain/capacity-standard-note";
import { pageTitle } from "@/lib/page-metadata";

export const dynamic = "force-dynamic";
export const generateMetadata = pageTitle("nav.heatmap");

export default async function HeatmapPage(
  { searchParams }: { searchParams: Promise<{ wh?: string; sloc?: string }> }
) {
  const { wh, sloc } = await searchParams;
  const codes = getWarehouses().warehouses.map((w) => w.code);
  const initial = wh && codes.includes(wh.toUpperCase()) ? wh.toUpperCase() : codes[0];
  const t = await getT();
  return (
    <div className="dashboard-page">
      <PageHeader eyebrow={t("heat.hint")} title={t("heat.title")} />
      <CapacityStandardNote warehouse={initial} />
      <HeatmapGrid warehouses={codes} initialWh={initial} initialSloc={sloc} />
    </div>
  );
}
