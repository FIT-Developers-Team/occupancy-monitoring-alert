// Menerjemahkan kondisi kapasitas menjadi tingkat keparahan alert.
//
// KENAPA MODUL TERSENDIRI
// -----------------------
// Sebelumnya tingkat keparahan ditanam di kode: setiap breach zona selalu
// CRITICAL dan setiap lokasi kelebihan kapasitas selalu HIGH. Itu membuang satu
// informasi yang paling menentukan tindakan — BERAPA BANYAK basis yang
// melampaui kapasitasnya.
//
// Satu basis melewati kapasitas masih dapat berarti kapasitas master pada basis
// itu yang salah: sebuah lokasi bisa 5.000% penuh menurut CBM sementara Qty-nya
// santai, dan yang perlu diperbaiki adalah angka max_cbm, bukan gudangnya.
// Qty DAN CBM sama-sama melewati kapasitas tidak punya penjelasan seperti itu:
// dua pengukuran independen sepakat bahwa lokasinya memang penuh. Dua kondisi
// itu memerlukan tindakan yang berbeda, jadi keduanya tidak boleh berbagi warna
// maupun tingkat eskalasi yang sama.
//
// TEPAT DI KAPASITAS vs MELEBIHI KAPASITAS
// ----------------------------------------
// Versi sebelumnya menyamakan keduanya lewat satu perbandingan `pct >= 100`.
// Padahal keduanya adalah kondisi gudang yang berbeda:
//
//  - Isi PERSIS sama dengan kapasitas maksimum berarti lokasinya penuh dan
//    tidak boleh menerima inbound lagi — tetapi belum ada satu unit pun yang
//    tidak punya tempat. Angka masternya konsisten dengan kenyataan.
//  - Isi MELEBIHI kapasitas maksimum berarti barangnya sudah tidak muat: ada
//    yang menumpuk di gang, atau angka kapasitas masternya salah.
//
// Karena itu "Qty dan CBM sama-sama TEPAT di kapasitas maksimum" adalah tingkat
// tersendiri (selalu Critical) di bawah "Qty dan CBM sama-sama MELEBIHI
// kapasitas" (bawaan Breach/EMERGENCY), bukan disamakan dengan keduanya.
//
// Aturannya berlaku sama untuk zona dan lokasi, dan dipakai juga oleh teks
// detail alert supaya penjelasannya tidak dapat menyimpang dari perhitungannya.
import { getThresholds, type OverflowSeverityConfig } from "@/lib/config";
import type { Basis, Severity } from "@/types";

/**
 * Toleransi kesetaraan persentase (poin persen).
 *
 * Okupansi dilaporkan dibulatkan ke satu desimal di seluruh aplikasi, jadi
 * "tepat di kapasitas" berarti angka yang DITAMPILKAN persis 100,0%. Setengah
 * langkah pembulatan (0,05) membuat penilaian alert selalu sepakat dengan angka
 * yang dibaca orang di layar, sekaligus kebal terhadap galat pembulatan
 * floating point (100,00000000000001 tetap terbaca tepat di kapasitas).
 */
export const CAPACITY_MATCH_TOLERANCE_PCT = 0.05;

/** max_qty/max_cbm efektif adalah 100%; kebijakan alert tidak boleh menggesernya. */
export const CAPACITY_LIMIT_PCT = 100;

/** Bentuk masukan yang sama untuk setiap bacaan okupansi dua basis. */
export interface BasisReading {
  /** Okupansi Qty (%); null berarti kapasitas Qty tidak sahih/tidak ada. */
  pct_qty: number | null;
  /** Okupansi CBM (%); null berarti kapasitas CBM tidak sahih/tidak ada. */
  pct_cbm: number | null;
}

export type OverflowKind =
  /** Qty DAN CBM sama-sama MELEBIHI kapasitas — dua pengukuran independen sepakat. */
  | "dual_over"
  /** Satu basis MELEBIHI kapasitas dan basis lainnya TEPAT di kapasitas. */
  | "dual_mixed"
  /** Qty DAN CBM sama-sama TEPAT di kapasitas maksimum, tidak melebihinya. */
  | "dual_at_capacity"
  /** Satu basis melebihi kapasitas sementara basis lainnya juga terukur. */
  | "single_over"
  /** Satu basis tepat di kapasitas maksimum sementara basis lainnya juga terukur. */
  | "single_at_capacity"
  /** Melebihi kapasitas, tetapi hanya satu basis yang punya kapasitas sahih. */
  | "single_measurable_over"
  /** Tepat di kapasitas, tetapi hanya satu basis yang punya kapasitas sahih. */
  | "single_measurable_at_capacity"
  /** Belum ada basis yang mencapai kapasitas. */
  | "none";

export interface OverflowVerdict {
  kind: OverflowKind;
  severity: Severity;
  /**
   * Basis yang MENCAPAI kapasitas — tepat di kapasitas maupun melebihinya.
   * Inilah ukuran "kondisi kapasitas terlihat", dipakai pemicu dan pemulihan.
   */
  reached: Basis[];
  /** Basis yang benar-benar MELEBIHI kapasitas, urut Qty lalu CBM. */
  exceeded: Basis[];
  /** Basis yang isinya TEPAT sama dengan kapasitas maksimum. */
  at_capacity: Basis[];
  /** Basis yang punya kapasitas sahih sehingga dapat dinilai sama sekali. */
  measurable: Basis[];
  /** Ambang "melebihi kapasitas" yang berlaku (%). */
  overPct: number;
  /** Persentase tertinggi di antara basis yang terukur; null bila tak terukur. */
  worstPct: number | null;
}

/** Setiap kondisi dipetakan ke satu kunci kebijakan, tidak ada yang tersisa. */
const POLICY_KEY: Record<OverflowKind, keyof Omit<OverflowSeverityConfig, "over_pct">> = {
  dual_over: "dual_basis",
  dual_mixed: "dual_basis",
  dual_at_capacity: "dual_at_capacity",
  single_over: "single_basis",
  single_at_capacity: "single_at_capacity",
  single_measurable_over: "single_measurable",
  // Hanya satu basis yang terukur DAN isinya tepat di kapasitas: dua alasan
  // untuk tidak menaikkannya di atas tingkat "tepat di kapasitas".
  single_measurable_at_capacity: "single_at_capacity",
  none: "threshold_only",
};

/**
 * Klasifikasikan satu bacaan okupansi.
 *
 * Keparahan `threshold_only` dikembalikan ketika belum ada basis yang mencapai
 * kapasitas — dipakai zona, yang tetap boleh beralert karena melewati ambang
 * breach yang dapat diatur meski ambang itu berada di bawah 100%.
 */
export function classifyOverflow(reading: BasisReading): OverflowVerdict {
  const policy = getThresholds().overflow_severity;
  // `over_pct` dipertahankan di bentuk config untuk migrasi instalasi lama,
  // tetapi batas fisik selalu 100% dari max yang sudah diselesaikan query.
  const overPct = CAPACITY_LIMIT_PCT;
  const tolerance = CAPACITY_MATCH_TOLERANCE_PCT;

  const measurable: Basis[] = [];
  const reached: Basis[] = [];
  const exceeded: Basis[] = [];
  const atCapacity: Basis[] = [];
  let worstPct: number | null = null;

  // Dua basis diperiksa terpisah dan eksplisit. Memakai `pct` basis kebijakan
  // saja adalah cacat asli logika ini: lokasi yang kelebihan kapasitas pada
  // basis NON-kebijakan tidak pernah terlihat sama sekali.
  for (const [basis, pct] of [["qty", reading.pct_qty], ["cbm", reading.pct_cbm]] as const) {
    if (pct === null || !Number.isFinite(pct)) continue;
    measurable.push(basis);
    worstPct = worstPct === null ? pct : Math.max(worstPct, pct);
    if (pct < overPct - tolerance) continue;
    reached.push(basis);
    if (pct > overPct + tolerance) exceeded.push(basis);
    else atCapacity.push(basis);
  }

  // Satu basis tepat di kapasitas sementara basis lainnya sudah melebihinya
  // bukan lagi kondisi "tepat di kapasitas": ada isi yang benar-benar tidak
  // muat, dan itu tidak boleh diturunkan tingkatnya hanya karena basis satunya
  // kebetulan berhenti pas di angka maksimum.
  const kind: OverflowKind =
    reached.length === 0 ? "none"
    : reached.length >= 2
      ? exceeded.length >= 2 ? "dual_over"
      : exceeded.length === 1 ? "dual_mixed"
      : "dual_at_capacity"
    : measurable.length >= 2 ? (exceeded.length ? "single_over" : "single_at_capacity")
    : exceeded.length ? "single_measurable_over"
    : "single_measurable_at_capacity";

  return {
    kind,
    // Pertahanan berlapis: sekalipun sumber config lama/bypass mengirim nilai
    // lain, kontrak dua basis tepat di max tetap Critical.
    severity: kind === "dual_at_capacity" ? "CRITICAL" : policy[POLICY_KEY[kind]],
    reached,
    exceeded,
    at_capacity: atCapacity,
    measurable,
    overPct,
    worstPct,
  };
}

/**
 * Alert kapasitas hanya dibuat ketika sebuah basis benar-benar MELEWATI
 * kapasitas.
 *
 * Isi yang PERSIS sama dengan angka maksimum bukan kejadian yang perlu
 * membangunkan orang: lokasinya penuh, tidak boleh menerima inbound lagi, dan
 * itu sudah terbaca di heatmap sebagai Kritis. Yang layak diberitakan adalah
 * saat ada barang yang benar-benar tidak punya tempat — dan itulah yang
 * diperiksa di sini.
 *
 * Pembeda tepat-di-max versus melewati-max tetap hidup di classifyOverflow()
 * karena tangga keparahannya masih memakai keduanya; yang berubah hanya
 * ambang untuk memberitakannya.
 */
export function hasExceededCapacity(verdict: OverflowVerdict): boolean {
  return verdict.exceeded.length > 0;
}
