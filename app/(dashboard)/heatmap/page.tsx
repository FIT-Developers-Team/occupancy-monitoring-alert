import { getWarehouses } from "@/lib/config";
import { getBasisMode } from "@/lib/basis";
import { getT } from "@/lib/i18n";
import HeatmapGrid from "@/components/domain/heatmap-grid";
import SlocExplorer from "@/components/domain/sloc-explorer";
import Section from "@/components/ui/section";
import PageHeader from "@/components/ui/page-header";
import CapacityStandardNote from "@/components/domain/capacity-standard-note";
import { pageTitle } from "@/lib/page-metadata";

export const dynamic = "force-dynamic";
export const generateMetadata = pageTitle("nav.heatmap");

export default async function HeatmapPage(
  { searchParams }: { searchParams: Promise<{ wh?: string; sloc?: string; zone?: string }> }
) {
  const { wh, sloc, zone } = await searchParams;
  const codes = getWarehouses().warehouses.map((w) => w.code);
  const initial = wh && codes.includes(wh.toUpperCase()) ? wh.toUpperCase() : codes[0];
  const [t, mode] = await Promise.all([getT(), getBasisMode()]);
  return (
    <div className="dashboard-page">
      <PageHeader eyebrow={t("heat.hint")} title={t("heat.title")} />
      <CapacityStandardNote warehouse={initial} />
      <HeatmapGrid warehouses={codes} initialWh={initial} initialSloc={sloc} />

      {/* Grid menjawab "di mana", tabel menjawab "yang mana" — termasuk mencari
          lintas ribuan lokasi tanpa harus membuka satu per satu zona. */}
      <Section eyebrow={`${initial} · ${t("slocx.hint")}`} title={t("heat.tableView")}>
        <SlocExplorer
          lockedWh={initial}
          initialFilter={zone ? { zone: zone.toUpperCase() } : undefined}
          initialView={mode}
          storageKey="heatmap"
        />
      </Section>
    </div>
  );
}
