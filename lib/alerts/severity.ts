// Menerjemahkan kelebihan kapasitas menjadi tingkat keparahan alert.
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
// Aturannya berlaku sama untuk zona dan lokasi, dan dipakai juga oleh teks
// detail alert supaya penjelasannya tidak dapat menyimpang dari perhitungannya.
import { getThresholds } from "@/lib/config";
import type { Basis, Severity } from "@/types";

/** Bentuk masukan yang sama untuk zona (ZoneSummary) dan lokasi (DenseSloc). */
export interface BasisReading {
  /** Okupansi Qty (%); null berarti kapasitas Qty tidak sahih/tidak ada. */
  pct_qty: number | null;
  /** Okupansi CBM (%); null berarti kapasitas CBM tidak sahih/tidak ada. */
  pct_cbm: number | null;
}

export type OverflowKind =
  /** Qty DAN CBM melebihi kapasitas — dua pengukuran independen sepakat. */
  | "dual_basis"
  /** Satu basis melebihi kapasitas sementara basis lainnya juga terukur. */
  | "single_basis"
  /** Melebihi kapasitas, tetapi hanya satu basis yang punya kapasitas sahih. */
  | "single_measurable"
  /** Belum ada basis yang melebihi kapasitas. */
  | "none";

export interface OverflowVerdict {
  kind: OverflowKind;
  severity: Severity;
  /** Basis yang melebihi kapasitas, urut Qty lalu CBM. */
  over: Basis[];
  /** Basis yang punya kapasitas sahih sehingga dapat dinilai sama sekali. */
  measurable: Basis[];
  /** Ambang "melebihi kapasitas" yang berlaku (%). */
  overPct: number;
  /** Persentase tertinggi di antara basis yang terukur; null bila tak terukur. */
  worstPct: number | null;
}

/**
 * Klasifikasikan satu bacaan okupansi.
 *
 * `overflowOnly` = false (bawaan) mengembalikan keparahan `threshold_only`
 * ketika belum ada basis yang melewati kapasitas — dipakai zona, yang tetap
 * boleh beralert karena melewati ambang breach yang dapat diatur meski ambang
 * itu berada di bawah 100%.
 */
export function classifyOverflow(reading: BasisReading): OverflowVerdict {
  const policy = getThresholds().overflow_severity;
  const overPct = policy.over_pct;

  const measurable: Basis[] = [];
  const over: Basis[] = [];
  let worstPct: number | null = null;

  // Dua basis diperiksa terpisah dan eksplisit. Memakai `pct` basis kebijakan
  // saja adalah cacat asli logika ini: lokasi yang kelebihan kapasitas pada
  // basis NON-kebijakan tidak pernah terlihat sama sekali.
  for (const [basis, pct] of [["qty", reading.pct_qty], ["cbm", reading.pct_cbm]] as const) {
    if (pct === null || !Number.isFinite(pct)) continue;
    measurable.push(basis);
    worstPct = worstPct === null ? pct : Math.max(worstPct, pct);
    if (pct >= overPct) over.push(basis);
  }

  const kind: OverflowKind =
    over.length >= 2 ? "dual_basis"
    : over.length === 1 ? (measurable.length >= 2 ? "single_basis" : "single_measurable")
    : "none";

  const severity: Severity =
    kind === "dual_basis" ? policy.dual_basis
    : kind === "single_basis" ? policy.single_basis
    : kind === "single_measurable" ? policy.single_measurable
    : policy.threshold_only;

  return { kind, severity, over, measurable, overPct, worstPct };
}

const BASIS_LABEL: Record<Basis, string> = { qty: "Qty", cbm: "CBM" };

/** Ringkasan satu baris untuk teks alert dan tooltip. */
export function overflowReason(verdict: OverflowVerdict): string {
  const names = verdict.over.map((basis) => BASIS_LABEL[basis]);
  switch (verdict.kind) {
    case "dual_basis":
      return `Qty dan CBM sama-sama melewati kapasitas (≥ ${verdict.overPct}%).`;
    case "single_basis":
      return `${names[0]} melewati kapasitas (≥ ${verdict.overPct}%), basis lainnya masih di dalam kapasitas.`;
    case "single_measurable":
      return `${names[0]} melewati kapasitas (≥ ${verdict.overPct}%). Hanya basis ini yang punya kapasitas sahih, sehingga kondisi "Qty dan CBM sama-sama lewat" tidak dapat dibuktikan — atur kapasitas basis lainnya di Pengaturan agar penilaiannya lengkap.`;
    default:
      return `Melewati ambang breach, tetapi belum ada basis yang melebihi kapasitas (< ${verdict.overPct}%).`;
  }
}
