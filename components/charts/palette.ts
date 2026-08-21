export const WH_PALETTE = [
  "#3C83F6", "#14B8A6", "#EA580C", "#8B5CF6",
  "#DC2626", "#CA8A04", "#0EA5E9", "#64748B",
];

/**
 * Warna token tema, dibaca saat grafik digambar.
 *
 * Chart.js melukis ke canvas, jadi ia tidak dapat memakai `var(--…)` seperti
 * sisa aplikasi. Membaca nilainya di sini membuat grafik memakai tangga status
 * yang sama persis dengan lencana dan heatmap, alih-alih menyimpan salinan
 * warnanya sendiri yang menyimpang setiap kali paletnya digeser.
 */
function themeColor(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function chartTheme() {
  const dark = typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");
  return {
    grid: dark ? "rgba(148,163,184,0.14)" : "rgba(100,116,139,0.16)",
    ticks: dark ? "#94A3B8" : "#64748B",
    font: { family: "ui-monospace, SFMono-Regular, Consolas, monospace", size: 10 },
    accent: themeColor("--accent", dark ? "#619CF8" : "#3C83F6"),
    // Garis acuan memakai tingkat tangga yang sesuai dengan artinya: 95% adalah
    // Critical (oranye), 100% adalah batas kapasitas fisik alias Breach (merah).
    // Sebelumnya garis 100% digambar #0F172A — hampir hitam, dan pada tema
    // gelap benar-benar tidak terlihat di atas permukaannya sendiri.
    critical: themeColor("--st-critical-fg", dark ? "#FB923C" : "#C2410C"),
    breach: themeColor("--st-breach-fg", dark ? "#F87171" : "#B91C1C"),
  };
}

/** Kelipatan sumbu yang enak dibaca untuk rentang tertentu. */
function niceStep(span: number): number {
  if (span <= 12) return 2;
  if (span <= 30) return 5;
  if (span <= 80) return 10;
  return 20;
}

/**
 * Rentang sumbu okupansi yang mengikuti datanya.
 *
 * Kedua grafik sebelumnya mengunci sumbu Y pada 40–105%. Itu bukan pilihan
 * estetika, melainkan penyembunyi data: delapan gudang pada jaringan ini
 * berjalan antara 4% dan 45%, sehingga tujuh di antaranya tergambar seluruhnya
 * di bawah batas bawah sumbu dan grafik tren di Ringkasan tampil nyaris kosong.
 *
 * Batas atasnya salah ke arah sebaliknya. Aplikasi ini secara eksplisit
 * mengakui okupansi di atas 100% — itulah arti tingkat Breach, dan CBT saat ini
 * berada di 117% pada basis Qty — jadi memotong sumbu di 105 justru menyembunyikan
 * kondisi yang paling perlu dilihat orang.
 */
export function occupancyAxis(values: Array<number | null | undefined>): { min: number; max: number } {
  const points = values.filter((value): value is number =>
    typeof value === "number" && Number.isFinite(value));
  if (!points.length) return { min: 0, max: 100 };
  const low = Math.min(...points);
  const high = Math.max(...points);
  // Rentang minimum menjaga deret yang nyaris datar tetap terbaca sebagai garis
  // pada sumbu bernilai, bukan sebagai getaran setinggi seluruh panel.
  const span = Math.max(high - low, 5);
  const step = niceStep(span);
  const pad = Math.max(step, span * 0.12);
  const min = Math.max(0, Math.floor((low - pad) / step) * step);
  const max = Math.ceil((high + pad) / step) * step;
  return { min, max: Math.max(max, min + step * 2) };
}
