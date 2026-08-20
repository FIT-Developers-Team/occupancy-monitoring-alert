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

/** Bentuk masukan yang sama untuk zona (ZoneSummary) dan lokasi (DenseSloc). */
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

/** Qty dan CBM sama-sama mencapai kapasitas — dua pengukuran independen sepakat. */
export function isDualBasis(verdict: OverflowVerdict): boolean {
  return verdict.reached.length >= 2;
}

/** Mencapai kapasitas tanpa satu basis pun melebihinya (tepat di angka maksimum). */
export function isAtCapacityOnly(verdict: OverflowVerdict): boolean {
  return verdict.reached.length > 0 && verdict.exceeded.length === 0;
}

/** Zona memicu alert bila salah satu basis mencapai max atau ambang breach tercapai. */
export function shouldTriggerZoneCapacityAlert(
  verdict: OverflowVerdict,
  policyPct: number,
  breachPct: number,
): boolean {
  return verdict.reached.length > 0 || policyPct >= breachPct;
}

/**
 * Zona baru pulih sesudah seluruh basis turun dari max DAN basis kebijakan
 * melewati sisi bawah hysteresis. Pemicu dan pemulihan sengaja tidak simetris
 * satu angka agar nilai yang berosilasi dekat batas tidak membuka/menutup alert
 * pada setiap tick.
 */
export function isZoneCapacityRecovered(
  verdict: OverflowVerdict,
  policyPct: number,
  breachPct: number,
  hysteresisBufferPct: number,
): boolean {
  return verdict.reached.length === 0
    && policyPct < breachPct - hysteresisBufferPct;
}

/** Dua basis di max selalu memicu; satu basis tetap mengikuti pengendali volume. */
export function shouldTriggerSlocCapacityAlert(
  verdict: OverflowVerdict,
  minPct: number,
): boolean {
  return isDualBasis(verdict) || (verdict.worstPct ?? 0) >= minPct;
}

/**
 * Alert lokasi yang sudah terbuka dipertahankan selama basis mana pun masih
 * penuh, meski bacaan turun dari 110% ke 100%. Ini mencegah alert yang sama
 * tutup lalu terbuka lagi akibat fluktuasi kecil di batas fisik.
 */
export function shouldKeepSlocCapacityAlertOpen(
  verdict: OverflowVerdict,
  minPct: number,
): boolean {
  return verdict.reached.length > 0 || (verdict.worstPct ?? 0) >= minPct;
}

const BASIS_LABEL: Record<Basis, string> = { qty: "Qty", cbm: "CBM" };

/** "Qty dan CBM" / "Qty" — daftar basis yang enak dibaca di kalimat. */
export function basisNames(bases: Basis[]): string {
  return bases.map((basis) => BASIS_LABEL[basis]).join(" dan ");
}

/**
 * Batas kapasitas sebagaimana disebut dalam kalimat.
 *
 * 100% berarti "sama dengan kapasitas maksimum yang disetel". Angka ini adalah
 * batas fisik hasil max_qty/max_cbm efektif, bukan ambang operasional yang dapat
 * digeser dari halaman Pengaturan.
 */
function capacityMark(overPct: number): string {
  return overPct === 100 ? "kapasitas maksimum" : `${overPct}% kapasitas`;
}

/** Ringkasan satu baris untuk teks alert dan tooltip. */
export function overflowReason(verdict: OverflowVerdict): string {
  const mark = capacityMark(verdict.overPct);
  const reached = basisNames(verdict.reached);
  switch (verdict.kind) {
    case "dual_over":
      return `Qty dan CBM sama-sama melewati ${mark} (> ${verdict.overPct}%).`;
    case "dual_mixed":
      return `${basisNames(verdict.exceeded)} melewati ${mark}, sementara ${basisNames(verdict.at_capacity)} tepat di ${mark}; Qty dan CBM sama-sama sudah mencapai batas.`;
    case "dual_at_capacity":
      return `Qty dan CBM sama-sama tepat di ${mark} — isinya persis sama dengan angka maksimum yang disetel, jadi lokasinya penuh meski belum ada yang melebihi.`;
    case "single_over":
      return `${reached} melewati ${mark} (> ${verdict.overPct}%), basis lainnya masih di dalam kapasitas.`;
    case "single_at_capacity":
      return `${reached} tepat di ${mark}, basis lainnya masih di dalam kapasitas.`;
    case "single_measurable_over":
      return `${reached} melewati ${mark} (> ${verdict.overPct}%). Hanya basis ini yang punya kapasitas sahih, sehingga kondisi "Qty dan CBM sama-sama lewat" tidak dapat dibuktikan — atur kapasitas basis lainnya di Pengaturan agar penilaiannya lengkap.`;
    case "single_measurable_at_capacity":
      return `${reached} tepat di ${mark}. Hanya basis ini yang punya kapasitas sahih, sehingga kondisi "Qty dan CBM sama-sama penuh" tidak dapat dibuktikan — atur kapasitas basis lainnya di Pengaturan agar penilaiannya lengkap.`;
    default:
      return `Melewati ambang breach, tetapi belum ada basis yang mencapai ${mark} (< ${verdict.overPct}%).`;
  }
}
