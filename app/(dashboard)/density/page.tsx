import { getSlocSummary, getWarehouseOccupancySummary } from "@/lib/queries";
import { getBasisMode } from "@/lib/basis";
import { parseSlocFilter } from "@/lib/sloc-filter";
import { getLang, getT } from "@/lib/i18n";
import { formatters } from "@/lib/utils";
import Section from "@/components/ui/section";
import KpiCard from "@/components/ui/kpi-card";
import SlocExplorer from "@/components/domain/sloc-explorer";
import PageHeader from "@/components/ui/page-header";
import CapacityStandardNote from "@/components/domain/capacity-standard-note";
import { pageTitle } from "@/lib/page-metadata";

export const dynamic = "force-dynamic";
export const generateMetadata = pageTitle("nav.density");

/**
 * Halaman ini dulu hanya menampilkan lokasi di atas satu ambang. Filternya kini
 * penuh — pencarian, zona, status, rentang okupansi, dan SLOC kosong — karena
 * pertanyaan operasional yang sebenarnya bukan hanya "mana yang penuh" tetapi
 * juga "di mana masih ada tempat".
 */
export default async function DensityPage(
  { searchParams }: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }
) {
  const raw = await searchParams;
  const [t, mode, lang] = await Promise.all([getT(), getBasisMode(), getLang()]);
  const f = formatters(lang);

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value) && value[0]) params.set(key, value[0]);
  }
  // Ambang lama (?min=90) tetap dihormati agar tautan yang sudah beredar dan
  // tersimpan di bookmark operasional tidak berubah arti.
  if (!params.has("view")) params.set("view", mode);
  const filter = parseSlocFilter(params);

  // KPI hanya butuh angka, jadi cukup ringkasan gudang (sudah di-cache) dan
  // hitungan status per gudang — bukan halaman baris yang harus diurutkan.
  const [summaries, breach] = await Promise.all([
    getWarehouseOccupancySummary(),
    getSlocSummary({
      ...filter,
      zone: "", rackZone: "", storage: "", q: "",
      status: ["CRITICAL", "BREACH"], fill: "all", minPct: null, maxPct: null,
    }),
  ]);
  const scope = summaries.filter((warehouse) => !filter.wh || warehouse.code === filter.wh);
  const totalSloc = scope.reduce((sum, warehouse) => sum + warehouse.sloc_total, 0);
  const filled = scope.reduce((sum, warehouse) => sum + warehouse.sloc_occupied, 0);
  const empty = scope.reduce((sum, warehouse) => sum + warehouse.sloc_empty, 0);

  return (
    <div className="dashboard-page">
      <PageHeader eyebrow={t("dens.subtitle")} title={t("dens.title")} />

      <div className="metric-strip metric-strip-four">
        <KpiCard
          label={t("slocx.preset.breach")}
          value={f.num(breach.total)}
          tone={breach.total ? "critical" : "normal"}
          sub={`${filter.wh || t("common.allWarehouses")} · ${t(`basis.${filter.view}`)}`}
        />
        <KpiCard
          label={t("occ.slocOccupied")}
          value={f.num(filled)}
          tone="accent"
          sub={`${t("common.of")} ${f.num(totalSloc)} ${t("common.active")}`}
        />
        <KpiCard
          label={t("occ.emptySloc")}
          value={f.num(empty)}
          sub={`${f.pct(totalSloc ? (empty / totalSloc) * 100 : 0)} ${t("common.empty").toLocaleLowerCase()}`}
        />
        <KpiCard
          label="Bin"
          value={f.pct(totalSloc ? (filled / totalSloc) * 100 : 0)}
          tone="teal"
          sub={t("basis.binHint")}
        />
      </div>

      <CapacityStandardNote warehouse={filter.wh || undefined} />

      <Section
        eyebrow={`${t("slocx.hint")} · ${t("dens.clickDetail")}`}
        title={t("slocx.title")}
      >
        <SlocExplorer initialFilter={filter} initialView={filter.view} storageKey="density" syncUrl />
      </Section>
    </div>
  );
}
