"use client";
// Riwayat pergerakan sebuah lokasi — SATU tampilan, dipakai setiap panel detail.
//
// KENAPA SATU KOMPONEN
// --------------------
// Daftar ini sebelumnya hanya ada di panel heatmap, ditulis langsung di dalam
// JSX-nya. Akibatnya dua hal:
//
//  1. Penjelajah SLOC tidak punya riwayat sama sekali — padahal endpoint yang
//     dipakainya (`/api/sloc`) SUDAH mengembalikan `movements` di setiap
//     jawaban. Datanya diambil, lalu dibuang begitu saja.
//  2. Salinan tunggal itu menyimpang sendiri: ia memformat waktu dengan
//     `toLocaleString(locale)` tanpa `timeZone`, satu-satunya tempat di aplikasi
//     ini yang tidak memakai pemformat bersama — sehingga peramban di luar WIB
//     melihat jam yang berbeda dari setiap layar lain.
//
// Keduanya adalah gejala dari hal yang sama, jadi perbaikannya juga satu:
// daftarnya menjadi komponen, dan setiap panel memanggilnya.
import Link from "next/link";
import type { MovementRow } from "@/lib/movements";
import { formatters } from "@/lib/utils";
import { useT } from "@/lib/i18n-client";

export default function SlocMovementList({
  movements,
  slocCode,
  loading = false,
  highlightUid = null,
}: {
  movements: MovementRow[];
  /** Dipakai untuk tautan "lihat semua" ke halaman Pergerakan. */
  slocCode: string;
  loading?: boolean;
  /**
   * Pergerakan yang ditandai sebagai penambahan terakhir pada lokasi ini.
   *
   * Daftar ini memuat kejadian masuk DAN keluar, berurutan waktu. Tanpa
   * penanda, pembaca harus menebak sendiri baris mana yang membuat rak menjadi
   * sepenuh sekarang — dan tebakan yang paling wajar, yaitu baris teratas,
   * justru sering salah karena kejadian terakhir di sebuah rak penuh biasanya
   * pengambilan barang.
   */
  highlightUid?: string | null;
}) {
  const { t, lang } = useT();
  const f = formatters(lang);

  if (loading) {
    return <p className="mvlist-muted">{t("common.loading")}</p>;
  }
  if (movements.length === 0) {
    return <p className="mvlist-muted">{t("heat.noMovementSynced")}</p>;
  }

  return (
    <>
      <ul className="mvlist">
        {movements.map((movement) => {
          const sign = movement.direction === "OUT" ? "−" : movement.direction === "IN" ? "+" : "";
          const isCause = highlightUid !== null && movement.movement_uid === highlightUid;
          return (
            <li key={movement.movement_uid} className={isCause ? "is-cause" : undefined}>
              <div className="mvlist-main">
                {/* Tipe kanonik, bukan teks aksi mentah: satu kegiatan yang sama
                    tidak boleh tampil dengan tiga ejaan berbeda pada panel
                    sesempit ini. Ejaan aslinya tetap tersedia sebagai tooltip. */}
                <strong title={movement.action_raw}>
                  {t(`mv.type.${movement.movement_type}`)}
                  {isCause && <em className="mvlist-cause-tag">{t("slocx.cause")}</em>}
                </strong>
                {/* Pemformat bersama, sama dengan tabel Pergerakan dan teks
                    alert — termasuk koreksi jam sumber dan penanda WIB. */}
                <span className="num">{f.dateTime(movement.at)}</span>
                <span className="num" title={movement.product_name}>
                  {movement.destination_sloc
                    ? `${movement.source_sloc ?? "—"} → ${movement.destination_sloc}`
                    : movement.source_sloc ?? "—"}
                </span>
              </div>
              <div className="mvlist-value">
                <b className={`num mvx-qty mvx-${movement.direction.toLowerCase()}`}>
                  {sign}{f.num(movement.qty)}
                </b>
                <span title={movement.operator}>{movement.operator || "—"}</span>
              </div>
            </li>
          );
        })}
      </ul>
      {/* Daftar ini sengaja pendek. Ketika seseorang perlu lebih dari sepuluh
          kejadian terakhir, yang dicarinya adalah halaman Pergerakan — dan
          sebelumnya ia harus menyalin kode SLOC-nya sendiri ke sana. */}
      <Link className="mvlist-more" prefetch={false}
        href={`/movements?sloc=${encodeURIComponent(slocCode)}&range=14d`}>
        {t("mv.viewAllForSloc")} →
      </Link>
    </>
  );
}
