import { getMovementFacets } from "@/lib/queries";
import { getLang, getT } from "@/lib/i18n";
import { formatters } from "@/lib/utils";
import Section from "@/components/ui/section";
import PageHeader from "@/components/ui/page-header";
import MovementExplorer from "@/components/domain/movement-explorer";
import { pageTitle } from "@/lib/page-metadata";

export const dynamic = "force-dynamic";
export const generateMetadata = pageTitle("nav.movements");

/**
 * Pergerakan stok — dataset Superset 705.
 *
 * Halaman ini menjawab pertanyaan yang tidak dapat dijawab oleh okupansi:
 * okupansi menunjukkan KEADAAN sebuah lokasi, pergerakan menunjukkan APA YANG
 * MEMBUATNYA begitu. Karena itu keduanya saling menunjuk — setiap baris di sini
 * dapat dibuka ke heatmap lokasinya, dan panel lokasi pada heatmap menampilkan
 * pergerakan terakhirnya.
 */
export default async function MovementsPage() {
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const f = formatters(lang);
  // Panel standardisasi dirender di server: isinya berubah hanya ketika WMS
  // memperkenalkan ejaan aksi baru, jadi tidak perlu ikut siklus filter tabel.
  const facets = await getMovementFacets().catch(() => null);
  const unmapped = (facets?.actions ?? []).filter((action) => action.type === "OTHER");

  return (
    <div className="dashboard-page">
      <PageHeader eyebrow={t("mv.subtitle")} title={t("mv.title")} />

      <Section eyebrow={t("mv.tableHint")} title={t("mv.tableTitle")} variant="panel">
        <MovementExplorer storageKey="movements" syncUrl />
      </Section>

      {(facets?.actions.length ?? 0) > 0 && (
        <Section
          eyebrow={t("mv.mapping.hint")}
          title={t("mv.mapping.title")}
          variant="panel"
        >
          {unmapped.length > 0 && (
            <p className="mvx-mapping-warning">{t("mv.mapping.unmapped")}</p>
          )}
          <div className="mvx-mapping-grid">
            {facets!.actions.map((action) => (
              <div key={`${action.raw}-${action.type}`} className="mvx-mapping-row">
                <span className="num" title={action.raw}>{action.raw}</span>
                <b>{t(`mv.type.${action.type}`)}</b>
                <small className="num">{f.num(action.events)}</small>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
