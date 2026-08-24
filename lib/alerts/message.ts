// Kalimat alert — satu tempat, tanpa I/O.
//
// KENAPA MODUL TERSENDIRI
// -----------------------
// Teks yang sama muncul di tiga tempat: papan alert, kartu Google Chat, dan
// email. Selama masing-masing menyusunnya sendiri, ketiganya pasti menyimpang —
// dan yang paling sering menyimpang justru angkanya. Modul ini murni (tanpa
// basis data, tanpa konfigurasi), jadi ia dapat diuji langsung dan tidak dapat
// menarik DuckDB ke dalam bundel klien.
//
// GAYA PENULISAN
// --------------
// Alert dibaca di ponsel, di tengah lantai gudang, oleh orang yang sedang
// mengerjakan hal lain. Yang harus sampai dalam sekali baca hanya tiga hal:
// LOKASI mana, SEBERAPA lewat, dan APA yang harus dilakukan. Versi sebelumnya
// menulis satu paragraf yang menjelaskan mengapa dua basis kapasitas berbeda
// maknanya — penjelasan yang benar, tetapi bukan sesuatu yang perlu dibaca
// ulang setiap kali alert berbunyi. Penjelasan itu kini tinggal di kode dan di
// halaman Panduan, bukan di dalam notifikasi.
import { fmtCbm, fmtNum } from "@/lib/utils";
import type { Basis } from "@/types";

/** Bentuk minimum yang dibutuhkan kalimat alert — sengaja bukan MovementBreach. */
export interface BreachFacts {
  sloc_code: string;
  pct_qty: number | null;
  pct_cbm: number | null;
  occ_qty: number;
  cap_qty: number;
  occ_cbm: number;
  cap_cbm: number;
  /** Unit yang masuk ke lokasi ini selama jendela evaluasi. */
  qty_in: number;
  /** Waktu pergerakan terakhir yang menambah isi lokasi (ISO ber-offset). */
  last_at: string;
  last_operator: string;
}

export interface BreachMessage {
  title: string;
  detail: string;
}

/** Jam WIB saja — tanggalnya hampir selalu hari ini dan hanya memanjangkan baris. */
export function clockOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString("id-ID", {
    timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
}

/** "Qty 218% (480/220 unit)" — hanya basis yang benar-benar terukur. */
export function readingOf(facts: BreachFacts): string {
  const parts: string[] = [];
  if (facts.pct_qty !== null) {
    parts.push(`Qty ${fmtNum(facts.pct_qty, 0)}% (${fmtNum(facts.occ_qty)}/${fmtNum(facts.cap_qty)} unit)`);
  }
  if (facts.pct_cbm !== null) {
    parts.push(`CBM ${fmtNum(facts.pct_cbm, 0)}% (${fmtCbm(facts.occ_cbm)}/${fmtCbm(facts.cap_cbm)} m³)`);
  }
  return parts.join(" · ");
}

/**
 * Berapa banyak yang harus dipindahkan supaya kembali muat.
 *
 * Angka inilah yang membuat alert dapat langsung dikerjakan. Diambil dari basis
 * Qty bila terukur, karena unit adalah satuan yang dipakai orang di lantai:
 * "pindahkan 260 unit" dapat dihitung sambil berjalan, "kurangi 1,2 m³" tidak.
 */
export function excessOf(facts: BreachFacts): string | null {
  if (facts.pct_qty !== null && facts.occ_qty > facts.cap_qty) {
    return `${fmtNum(Math.ceil(facts.occ_qty - facts.cap_qty))} unit`;
  }
  if (facts.pct_cbm !== null && facts.occ_cbm > facts.cap_cbm) {
    return `${fmtCbm(facts.occ_cbm - facts.cap_cbm)} m³`;
  }
  return null;
}

/**
 * Judul + detail untuk satu lokasi yang lewat kapasitas.
 *
 * `exceeded` adalah basis yang benar-benar melewati kapasitas, hasil
 * classifyOverflow(). Dua basis sepakat berarti lokasinya memang penuh; satu
 * basis saja masih menyisakan kemungkinan angka master basis itu yang keliru,
 * dan menyebut kemungkinan itu mencegah orang memindahkan barang tanpa perlu.
 */
export function buildBreachMessage(facts: BreachFacts, exceeded: Basis[]): BreachMessage {
  const dual = exceeded.length >= 2;
  const basisLabel = dual ? "Qty & CBM" : exceeded[0] === "qty" ? "Qty" : "CBM";
  const worst = Math.max(facts.pct_qty ?? 0, facts.pct_cbm ?? 0);
  const excess = excessOf(facts);

  const title = dual
    ? `${facts.sloc_code} penuh — Qty & CBM lewat kapasitas`
    : `${facts.sloc_code} lewat kapasitas ${basisLabel} (${fmtNum(worst, 0)}%)`;

  const cause = `Masuk ${fmtNum(facts.qty_in)} unit pukul ${clockOf(facts.last_at)}`
    + (facts.last_operator ? ` oleh ${facts.last_operator}` : "")
    + ".";
  const action = dual
    ? `Pindahkan ${excess ?? "kelebihannya"} ke lokasi kosong terdekat.`
    : `Pindahkan ${excess ?? "kelebihannya"}, atau perbaiki kapasitas ${basisLabel} lokasi ini bila angkanya keliru.`;

  return { title, detail: `${cause} ${readingOf(facts)}. ${action}` };
}
