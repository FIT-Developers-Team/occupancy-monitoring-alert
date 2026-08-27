import { thresholdsFor } from "@/lib/config";
import { CAPACITY_MATCH_TOLERANCE_PCT } from "@/lib/alerts/severity";
import type { OccupancyStatus } from "@/types";

/**
 * BREACH ADALAH SIFAT LOKASI, BUKAN SIFAT SATU BASIS
 * ==================================================
 * Sebuah lokasi disebut Breach HANYA ketika Qty DAN CBM sama-sama melewati
 * kapasitas maksimum. Satu basis saja yang lewat berhenti di Kritis.
 *
 * Alasannya operasional, bukan kosmetik. Satu basis melewati kapasitas hampir
 * selalu punya penjelasan lain selain "gudangnya penuh": angka master pada
 * basis itu yang salah. Sebuah rak bisa terbaca 5.000% penuh menurut CBM karena
 * `max_volume`-nya diisi 0,001 m³, sementara Qty-nya santai — dan yang perlu
 * diperbaiki adalah angkanya, bukan gudangnya. Ketika DUA pengukuran yang
 * independen sepakat, penjelasan itu habis: barangnya memang tidak muat.
 *
 * Diukur pada basis data ini, aturan lama menandai 29.012 lokasi sebagai
 * Breach; aturan ini menandai 7.080. Dari 21.932 yang turun ke Kritis, 18.378
 * hanya lewat pada Qty dan 3.554 hanya pada CBM. Tiga perempat dari semua
 * tanda merah di layar selama ini adalah kondisi yang belum tentu breach.
 *
 * KONSEKUENSI YANG DISENGAJA
 * --------------------------
 * Ketika sebuah lokasi memenuhi syarat itu, SELURUH basis tampilan menyebutnya
 * Breach — termasuk saat pengguna sedang melihat basis Qty saja. "Breach" harus
 * berarti satu hal yang sama di setiap layar; kalau tidak, orang berhenti
 * mempercayai lencananya. Sebaliknya, basis yang lewat sendirian tidak pernah
 * menaikkan lencana ke Breach di tampilan mana pun.
 *
 * Lokasi yang hanya punya satu kapasitas sahih tidak akan pernah Breach: syarat
 * "keduanya lewat" tidak dapat dibuktikan, dan menghukum lubang di data master
 * dengan tanda merah tertinggi hanya memindahkan masalahnya ke layar.
 */

/** Bacaan dua basis — bentuk yang sama dengan lib/alerts/severity. */
export interface BasisPercentages {
  pct_qty: number | null;
  pct_cbm: number | null;
}

/**
 * Tangga untuk SATU persentase: NORMAL → MONITOR → WARNING → CRITICAL.
 *
 * Sengaja tidak pernah mengembalikan BREACH. Tingkat itu memerlukan kedua basis
 * dan karenanya tidak dapat diputuskan dari satu angka — lihat
 * `occupancyStatuses()`. Fungsi ini juga dipakai untuk basis Bin, yang memang
 * tidak pernah dapat melewati 100%.
 *
 * Ambang di bawah Kritis memakai `>=` karena Pantau/Waspada/Kritis adalah batas
 * operasional yang boleh disentuh, bukan batas fisik kapasitas.
 */
export function rungFor(pct: number, warehouseCode: string): OccupancyStatus {
  const t = thresholdsFor(warehouseCode);
  if (pct >= t.critical) return "CRITICAL";
  if (pct >= t.warning) return "WARNING";
  if (pct >= t.monitor) return "MONITOR";
  return "NORMAL";
}

/**
 * Apakah satu basis melewati kapasitas maksimum.
 *
 * MENCAPAI AMBANG ≠ MELEWATINYA. Isi yang PERSIS sama dengan angka maksimum
 * berarti lokasinya penuh dan harus berhenti menerima inbound, tetapi belum ada
 * satu unit pun yang tidak punya tempat — itu Kritis, bukan Breach.
 *
 * Toleransinya sama dengan yang dipakai mesin alert, sehingga status di layar
 * selalu sepakat dengan angka satu desimal di sebelahnya: 100,04% dibulatkan
 * menjadi "100,0%" dan tetap Kritis, sedangkan 100,06% menjadi "100,1%".
 */
function exceeds(pct: number | null, breachPct: number): boolean {
  return pct !== null && Number.isFinite(pct) && pct > breachPct + CAPACITY_MATCH_TOLERANCE_PCT;
}

/** Qty DAN CBM sama-sama melewati kapasitas maksimum. */
export function isDualBreach(reading: BasisPercentages, warehouseCode: string): boolean {
  const breachPct = thresholdsFor(warehouseCode).breach;
  return exceeds(reading.pct_qty, breachPct) && exceeds(reading.pct_cbm, breachPct);
}

export interface OccupancyStatusSet {
  /** Status pada basis kebijakan — yang tampil bila pengguna tidak memilih basis. */
  status: OccupancyStatus;
  status_qty: OccupancyStatus | null;
  status_cbm: OccupancyStatus | null;
}

/**
 * Satu keputusan status untuk satu baris, dipakai SETIAP read-model.
 *
 * Menyusun ketiganya di satu tempat adalah intinya: selama `status`,
 * `status_qty`, dan `status_cbm` dihitung terpisah di sepuluh tempat berbeda,
 * hanya soal waktu sampai salah satunya memakai aturan Breach yang berbeda.
 */
export function occupancyStatuses(
  reading: BasisPercentages,
  policyPct: number,
  warehouseCode: string,
): OccupancyStatusSet {
  const breached = isDualBreach(reading, warehouseCode);
  const rung = (pct: number | null) =>
    pct === null ? null : breached ? ("BREACH" as const) : rungFor(pct, warehouseCode);
  return {
    status: breached ? "BREACH" : rungFor(policyPct, warehouseCode),
    status_qty: rung(reading.pct_qty),
    status_cbm: rung(reading.pct_cbm),
  };
}

/**
 * Status satu baris yang hanya punya satu persentase di tangan.
 *
 * Dipakai isi zona, yang menampilkan okupansi lokasi di samping baris stok.
 * Bacaan dua basisnya ikut dikirim supaya lencananya tidak dapat berbeda dari
 * lencana lokasi yang sama di heatmap.
 */
export function statusForRow(
  reading: BasisPercentages,
  policyPct: number,
  warehouseCode: string,
): OccupancyStatus {
  return occupancyStatuses(reading, policyPct, warehouseCode).status;
}

/** Tingkat tangga sebagai bilangan (0..4) — urutannya dipakai pengurutan. */
export function ladderLevel(
  reading: BasisPercentages,
  policyPct: number,
  warehouseCode: string,
): number {
  return ["NORMAL", "MONITOR", "WARNING", "CRITICAL", "BREACH"].indexOf(
    statusForRow(reading, policyPct, warehouseCode),
  );
}
