// Satu peta status okupansi -> warna, dipakai server maupun klien.
//
// Tangga statusnya lima tingkat, tetapi sebelum ini beberapa layar
// memperlakukannya sebagai empat: BREACH dipetakan ke warna CRITICAL karena
// keduanya kebetulan sama-sama merah. Setelah tangga digeser (Normal hijau,
// Monitor biru, Warning kuning, Critical oranye, Breach merah) penggabungan itu
// menjadi salah secara kasatmata — lokasi yang melewati kapasitas tampil oranye,
// warna yang kini berarti "mendekati", bukan "sudah lewat".
//
// Petanya berada di satu modul supaya tidak ada layar yang bisa menyimpang
// sendiri lagi. Modul ini sengaja tidak mengimpor apa pun dari read-model,
// sehingga aman dipakai komponen klien.
import type { OccupancyStatus, Severity } from "@/types";

export type Tone = "normal" | "monitor" | "warning" | "critical" | "breach";

export const STATUS_TONE: Record<OccupancyStatus, Tone> = {
  NORMAL: "normal",
  MONITOR: "monitor",
  WARNING: "warning",
  CRITICAL: "critical",
  BREACH: "breach",
};

/** Warna teks/aksen untuk sebuah status. */
export const STATUS_COLOR: Record<OccupancyStatus, string> = {
  NORMAL: "var(--st-normal-fg)",
  MONITOR: "var(--st-monitor-fg)",
  WARNING: "var(--st-warning-fg)",
  CRITICAL: "var(--st-critical-fg)",
  BREACH: "var(--st-breach-fg)",
};

/** Latar lembut untuk sebuah status. */
export const STATUS_BG: Record<OccupancyStatus, string> = {
  NORMAL: "var(--st-normal-bg)",
  MONITOR: "var(--st-monitor-bg)",
  WARNING: "var(--st-warning-bg)",
  CRITICAL: "var(--st-critical-bg)",
  BREACH: "var(--st-breach-bg)",
};

/**
 * Tingkat keparahan alert menempati tangga yang sama.
 *
 * Lima tingkat keparahan berpasangan satu-satu dengan lima status okupansi,
 * dan itu disengaja: operator membaca satu bahasa warna di seluruh aplikasi,
 * bukan dua. EMERGENCY adalah puncaknya — di sanalah "Qty dan CBM sama-sama
 * melewati kapasitas" mendarat.
 */
export const SEVERITY_TONE: Record<Severity, Tone> = {
  INFO: "normal",
  WARNING: "monitor",
  HIGH: "warning",
  CRITICAL: "critical",
  EMERGENCY: "breach",
};

export const SEVERITY_COLOR: Record<Severity, string> = {
  INFO: "var(--st-normal-fg)",
  WARNING: "var(--st-monitor-fg)",
  HIGH: "var(--st-warning-fg)",
  CRITICAL: "var(--st-critical-fg)",
  EMERGENCY: "var(--st-breach-fg)",
};
