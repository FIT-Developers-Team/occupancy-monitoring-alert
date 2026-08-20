import { thresholdsFor } from "@/lib/config";
import { CAPACITY_MATCH_TOLERANCE_PCT } from "@/lib/alerts/severity";
import type { OccupancyStatus } from "@/types";

/**
 * Peta okupansi % ke tangga status FIT memakai ambang per gudang.
 *
 * MENCAPAI AMBANG ≠ MELEWATINYA
 * -----------------------------
 * Versi sebelumnya memakai `pct >= breach` untuk BREACH, sehingga lokasi yang
 * isinya PERSIS sama dengan kapasitas maksimum — Qty 12/12, CBM 0,034/0,034 —
 * tampil "Breach" di heatmap, kartu zona, dan tabel kepadatan. Itu bertentangan
 * dengan aturan yang sudah berlaku di mesin alert, yang menilai kondisi sama
 * persis itu sebagai Critical: lokasinya penuh dan harus berhenti menerima
 * inbound, tetapi belum ada satu unit pun yang tidak punya tempat.
 *
 * Dua tangga yang berbeda pada satu angka yang sama membuat orang tidak dapat
 * mempercayai keduanya. Karena itu batas atas tangga status kini memakai
 * perbandingan yang sama dengan lib/alerts/severity.ts:
 *
 *   pct > breach   -> BREACH   (melewati batas; ada yang tidak muat)
 *   pct = breach   -> CRITICAL (tepat di batas; penuh, belum melewati)
 *
 * Rungs di bawahnya tetap memakai `>=` karena ambang Pantau/Waspada/Kritis
 * adalah batas operasional yang boleh disentuh, bukan batas fisik kapasitas.
 *
 * Toleransinya berbagi konstanta dengan mesin alert supaya status di layar
 * selalu sepakat dengan angka satu desimal yang ditampilkan di sebelahnya:
 * okupansi sebenarnya 100,04% dibulatkan menjadi "100,0%" dan tetap Critical,
 * sedangkan 100,06% menjadi "100,1%" dan sudah Breach.
 */
export function statusFor(pct: number, warehouseCode: string): OccupancyStatus {
  const t = thresholdsFor(warehouseCode);
  if (pct > t.breach + CAPACITY_MATCH_TOLERANCE_PCT) return "BREACH";
  if (pct >= t.critical) return "CRITICAL";
  if (pct >= t.warning) return "WARNING";
  if (pct >= t.monitor) return "MONITOR";
  return "NORMAL";
}

/** Ladder level as integer (0..4) — used by the hysteresis engine. */
export function ladderLevel(pct: number, warehouseCode: string): number {
  return ["NORMAL", "MONITOR", "WARNING", "CRITICAL", "BREACH"].indexOf(
    statusFor(pct, warehouseCode)
  );
}
