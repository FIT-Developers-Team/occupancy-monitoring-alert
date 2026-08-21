import Link from "next/link";
import { getCapacity, getThresholds, thresholdsFor } from "@/lib/config";
import { currentUser, isAdmin } from "@/lib/auth";
import { getLang, getT } from "@/lib/i18n";
import { formatters } from "@/lib/utils";

/**
 * Pernyataan singkat tentang kebijakan yang sedang membentuk setiap angka di
 * halaman ini.
 *
 * Tanpa ini, satu-satunya cara mengetahui mengapa sebuah persentase bernilai
 * tertentu adalah membuka halaman Pengaturan di tab lain dan mencocokkannya
 * sendiri. Yang paling sering menimbulkan pertanyaan adalah utilisasi volume:
 * kapasitas CBM yang ditampilkan sudah dikalikan faktor itu, sehingga max CBM
 * 0,0336 muncul sebagai 0,029 dan terlihat seperti konfigurasi yang tidak
 * diterapkan. Menampilkan rumusnya sekali di atas layar menutup jarak itu.
 */
export default async function CapacityStandardNote({
  warehouse,
}: {
  /** Bila diisi, ambang yang ditampilkan mengikuti override gudang tersebut. */
  warehouse?: string;
}) {
  const [t, user, lang] = await Promise.all([getT(), currentUser(), getLang()]);
  const f = formatters(lang);
  const capacity = getCapacity();
  // Pintasan hanya berguna bagi yang boleh membukanya; /settings menolak
  // supervisor, jadi menampilkan tautan itu kepada mereka hanya menyesatkan.
  const canEdit = user ? isAdmin(user.role) : false;
  const thresholds = warehouse ? thresholdsFor(warehouse) : getThresholds().default;
  const activeRules = capacity.rules.filter(
    (rule) => Object.keys(rule.scope).length > 0 || Object.keys(rule.set).length > 0,
  );
  const overrideRules = activeRules.length;
  // Contoh diambil dari nilai max_cbm yang paling sering dipakai di konfigurasi
  // ini, bukan angka karangan: yang perlu dikenali admin adalah angkanya
  // sendiri, supaya ia langsung melihat berapa nilai itu di layar.
  const cbmCounts = new Map<number, number>();
  for (const rule of activeRules) {
    if (rule.set.max_cbm === undefined) continue;
    cbmCounts.set(rule.set.max_cbm, (cbmCounts.get(rule.set.max_cbm) ?? 0) + 1);
  }
  const sampleCbm = [...cbmCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];

  return (
    <div className="standard-note" role="note">
      <div className="standard-note-main">
        <span className="eyebrow">{t("std.title")}</span>
        <p>
          {t("std.formula")}
          {sampleCbm !== undefined && (
            <>
              {" "}{t("std.example")}{" "}
              <b className="num">
                {f.capCbm(sampleCbm)} × {capacity.utilization_pct}%
                {" = "}
                {f.capCbm(sampleCbm * capacity.utilization_pct / 100)}
              </b>{" "}
              m³.
            </>
          )}{" "}
          {t("std.qtyNote")}
        </p>
      </div>
      <div className="standard-note-chips">
        <span className="chip" title={t("std.basisHint")}>
          {t("set.ui.capacity.basis")}: <b>{capacity.basis_default.toUpperCase()}</b>
        </span>
        <span className="chip" title={t("std.utilHint")}>
          {t("set.ui.capacity.volumeUtilisation")}: <b className="num">{capacity.utilization_pct}%</b>
        </span>
        <span className="chip" title={t("std.thresholdHint")}>
          {t("std.threshold")}:{" "}
          <b className="num">
            {thresholds.monitor}/{thresholds.warning}/{thresholds.critical}/{thresholds.breach}
          </b>
        </span>
        <span className="chip" title={capacity.count_statuses.join(", ")}>
          {t("set.ui.capacity.countedStatuses")}: <b>{capacity.count_statuses.length}</b>
        </span>
        {capacity.exclude_categories.length > 0 && (
          <span className="chip" title={capacity.exclude_categories.join(", ")}>
            {t("set.ui.capacity.excludedCategories")}: <b className="num">{capacity.exclude_categories.length}</b>
          </span>
        )}
        {capacity.disabled_zones.length > 0 && (
          <span className="chip" title={capacity.disabled_zones.map((zone) => `${zone.wh}/${zone.zone}`).join(", ")}>
            {t("set.ui.capacity.zonesDisabledCount")}: <b className="num">{capacity.disabled_zones.length}</b>
          </span>
        )}
        <span className="chip">
          {t("set.ui.capacity.overrideRules")}: <b className="num">{overrideRules}</b>
        </span>
        {canEdit && (
          <Link className="chip chip-accent" href="/settings" prefetch={false}>
            {t("std.open")} →
          </Link>
        )}
      </div>
    </div>
  );
}
