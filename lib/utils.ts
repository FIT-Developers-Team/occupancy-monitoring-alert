import { localeOf, makeT, type Lang } from "@/lib/i18n-dict";
import type { Severity } from "@/types";

/**
 * Pemformat angka, volume, persentase, dan waktu untuk satu bahasa.
 *
 * MENGAPA SATU PABRIK, BUKAN FUNGSI LEPAS
 * ---------------------------------------
 * Sebelumnya berkas ini mengekspor `fmtNum`, `fmtPct`, dan kawan-kawan yang
 * mengunci locale `id-ID`, sementara beberapa layar memformat angkanya sendiri
 * mengikuti bahasa yang dipilih. Keduanya lalu bertemu dalam satu baris yang
 * sama: pada ringkasan penjelajah lokasi dalam bahasa Inggris, jumlah lokasi
 * tampil "144,032" — dipisah koma karena memakai `toLocaleString(locale)` —
 * tepat di sebelah kapasitas "12.500" yang dipisah titik karena melewati
 * `fmtNum`. Angka yang sama, dua konvensi, satu baris.
 *
 * Halaman Integritas dan Audit sudah menyalin seluruh pemformat ini hanya untuk
 * mendapat versi yang mengikuti bahasa. Menjadikannya satu pabrik menghapus
 * salinan itu sekaligus menutup celahnya: setiap angka di layar memakai
 * konvensi bahasa yang sedang aktif, dan hanya ada satu tempat yang
 * memutuskannya.
 */
export interface Formatters {
  /** Bilangan dengan pemisah ribuan sesuai bahasa. */
  num(value: number | null | undefined, digits?: number): string;
  /** m³ adaptif: 0,039 · 2,55 · 12,4 · 130 */
  cbm(value: number | null | undefined): string;
  /** Kapasitas CBM apa adanya dari konfigurasi — tidak pernah dipotong ke 3 desimal. */
  capCbm(value: number | null | undefined): string;
  pct(value: number | null | undefined, digits?: number): string;
  dateTime(iso: string | null | undefined): string;
  /** Horizon menuju ambang okupansi, satuannya ikut diterjemahkan. */
  hours(value: number | null): string;
  /** Tanggal saja — dipakai kolom seperti "cycle count terakhir". */
  date(value: unknown): string;
  locale: string;
}

const DASH = "—";
const missing = (value: unknown): boolean =>
  value === null || value === undefined || (typeof value === "number" && Number.isNaN(value));

function build(lang: Lang): Formatters {
  const locale = localeOf(lang);
  const t = makeT(lang);

  const num: Formatters["num"] = (value, digits = 0) =>
    missing(value) ? DASH : (value as number).toLocaleString(locale, {
      maximumFractionDigits: digits, minimumFractionDigits: digits,
    });

  const cbm: Formatters["cbm"] = (value) => {
    if (missing(value)) return DASH;
    const magnitude = Math.abs(value as number);
    const digits = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : magnitude >= 1 ? 2 : 3;
    return (value as number).toLocaleString(locale, {
      maximumFractionDigits: digits, minimumFractionDigits: 0,
    });
  };

  /**
   * Berbeda dari `cbm`, format ini tidak pernah memotong ke tiga desimal.
   * Nilai seperti 0,0336 harus tampil persis seperti yang diketik admin di
   * Pengaturan; membulatkannya menjadi 0,034 justru menimbulkan pertanyaan yang
   * ingin dijawab baris itu.
   */
  const capCbm: Formatters["capCbm"] = (value) =>
    missing(value) ? DASH : (value as number).toLocaleString(locale, {
      maximumFractionDigits: 4, minimumFractionDigits: 0,
    });

  const pct: Formatters["pct"] = (value, digits = 1) =>
    missing(value) ? DASH : `${num(value, digits)}%`;

  const dateTime: Formatters["dateTime"] = (iso) => {
    if (!iso) return DASH;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return `${date.toLocaleString(locale, {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
      hourCycle: "h23", timeZone: "Asia/Jakarta",
    })} WIB`;
  };

  const date: Formatters["date"] = (value) => {
    const raw = String(value ?? "");
    if (!raw) return DASH;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return raw;
    return parsed.toLocaleDateString(locale, {
      day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Jakarta",
    });
  };

  /**
   * Satuannya diterjemahkan, bukan sekadar diformat. Versi sebelumnya menulis
   * "stabil", "mnt", "jam", dan "hari" apa adanya, sehingga tabel Proyeksi,
   * kartu gudang, dan simulator What-If tetap berbahasa Indonesia meski seluruh
   * halaman di sekelilingnya sudah berbahasa Inggris.
   */
  const hours: Formatters["hours"] = (value) => {
    const at = (key: string, amount: number) => t(key).replace("{n}", num(amount));
    if (value === null || !Number.isFinite(value)) return t("time.steady");
    if (value < 1) return at("time.minutes", Math.max(1, Math.round(value * 60)));
    if (value < 48) return at("time.hours", Math.round(value));
    return at("time.days", Math.round(value / 24));
  };

  return { num, cbm, capCbm, pct, dateTime, date, hours, locale };
}

const byLang = new Map<Lang, Formatters>();

/** Pemformat untuk sebuah bahasa; hasilnya dibagikan, jadi aman dipanggil per render. */
export function formatters(lang: Lang = "id"): Formatters {
  let cached = byLang.get(lang);
  if (!cached) {
    cached = build(lang);
    byLang.set(lang, cached);
  }
  return cached;
}

/**
 * Bentuk lepas berbahasa Indonesia.
 *
 * Dipertahankan untuk pemanggil di luar antarmuka — teks alert dan ringkasan
 * harian yang dikirim ke Google Chat — yang memang selalu Bahasa Indonesia dan
 * tidak punya bahasa layar untuk diikuti. Setiap layar memakai `formatters()`.
 */
const indonesian = formatters("id");
export const fmtNum = indonesian.num;
export const fmtCbm = indonesian.cbm;
export const fmtCapCbm = indonesian.capCbm;
export const fmtPct = indonesian.pct;
export const fmtDateTime = indonesian.dateTime;
export const fmtHours = indonesian.hours;

export const severityOrder: Severity[] = ["INFO", "WARNING", "HIGH", "CRITICAL", "EMERGENCY"];
export const severityRank = (s: Severity) => severityOrder.indexOf(s);
