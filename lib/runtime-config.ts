// Satu titik keputusan untuk "di mana konfigurasi yang bisa diubah admin
// disimpan", sehingga tidak ada satu pun bagian aplikasi yang menulis ke tempat
// yang hilang saat deployment diperbarui.
//
// LATAR BELAKANG
// --------------
// `config/*.json` ikut dibangun ke dalam image Docker. Setiap kali image
// dibangun ulang, isinya kembali ke versi yang ada di source control — jadi
// semua yang disimpan admin dari halaman Pengaturan (ambang, kapasitas,
// gudang, eskalasi, Superset) hilang setelah deploy berikutnya kecuali
// `/app/config` kebetulan dipasang sebagai volume permanen.
//
// `db/` sudah pasti permanen: history DuckDB, state alert, dan akun hidup di
// sana. Karena itu seluruh konfigurasi runtime ditulis ke
// `db/runtime-config/` dan `config/` diperlakukan hanya sebagai NILAI AWAL
// (seed) bawaan image.
//
// Aturan baca/tulis:
//   baca  : file runtime bila ada, kalau tidak ada pakai seed dari `config/`
//   tulis : selalu ke folder runtime
//
// Efeknya: instalasi lama tetap terbaca apa adanya (fallback), penyimpanan
// pertama memindahkannya ke volume permanen, dan deploy berikutnya tidak lagi
// menimpa apa pun yang sudah disimpan.
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

/** Nilai awal bawaan image — hanya dibaca, tidak pernah ditulis ulang. */
export const SEED_CONFIG_DIR = path.join(ROOT, "config");

/** Volume permanen. Sengaja berada di dalam `db/` yang sudah pasti di-mount. */
export const RUNTIME_CONFIG_DIR = process.env.WIOM_RUNTIME_CONFIG_DIR?.trim()
  ? path.resolve(process.env.WIOM_RUNTIME_CONFIG_DIR.trim())
  : path.join(ROOT, "db", "runtime-config");

/** Lokasi tulis kanonik untuk sebuah berkas konfigurasi. */
export function runtimeConfigFile(basename: string): string {
  return path.join(RUNTIME_CONFIG_DIR, basename);
}

/** Nilai awal bawaan image untuk sebuah berkas konfigurasi. */
export function seedConfigFile(basename: string): string {
  return path.join(SEED_CONFIG_DIR, basename);
}

/**
 * Berkas yang harus dipakai untuk operasi ini.
 *
 * `forWrite` selalu mengarah ke volume permanen. Pembacaan mengutamakan salinan
 * runtime dan hanya jatuh ke seed ketika admin belum pernah menyimpan apa pun.
 */
export function resolveConfigFile(basename: string, forWrite = false): string {
  const runtime = runtimeConfigFile(basename);
  if (forWrite) return runtime;
  return fs.existsSync(runtime) ? runtime : seedConfigFile(basename);
}

/** Benar bila berkas ini sudah pindah ke penyimpanan permanen. */
export function isPersisted(basename: string): boolean {
  return fs.existsSync(runtimeConfigFile(basename));
}

/**
 * Tulis JSON secara atomik.
 *
 * Penulisan langsung ke berkas tujuan menyisakan berkas terpotong bila proses
 * mati di tengah jalan — pada berkas kebijakan itu berarti aplikasi gagal
 * start setelah restart. Tulis ke berkas sementara di folder yang sama lalu
 * rename; rename dalam satu filesystem bersifat atomik.
 */
export function writeConfigJsonAtomic(file: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* sisa berkas sementara tidak fatal */ }
    throw error;
  }
}

export interface ConfigStorageInfo {
  /** Folder tempat setiap penyimpanan admin mendarat. */
  runtimeDir: string;
  /** Folder nilai awal bawaan image. */
  seedDir: string;
  /** Folder runtime benar-benar dapat ditulis oleh proses ini. */
  writable: boolean;
  /** Berkas yang sudah tersimpan permanen (aman terhadap deploy ulang). */
  persisted: string[];
  /** Berkas yang masih memakai nilai bawaan image. */
  usingSeed: string[];
  /**
   * Kode errno saat uji tulis gagal (mis. EACCES, EROFS) — tanpa path.
   *
   * /api/health dan /api/ready dapat diakses tanpa login, jadi pesan errno
   * mentah tidak boleh dikirim ke sana: teksnya memuat path absolut di server
   * dan itu memetakan struktur folder deployment untuk siapa pun yang bertanya.
   * Kodenya sendiri sudah cukup untuk mendiagnosis (izin vs volume read-only).
   */
  reason?: string;
}

const MANAGED_FILES = [
  "thresholds.json",
  "rules.json",
  "warehouses.json",
  "capacity.json",
  "recipients.json",
  "superset-sync.json",
  "accounts.json",
];

/** Seksi yang punya nilai awal di image dan wajib diamankan sebelum deploy berikutnya. */
const SEEDABLE_FILES = [
  "thresholds.json",
  "rules.json",
  "warehouses.json",
  "capacity.json",
  "recipients.json",
  "superset-sync.json",
];

let seeded = false;

/**
 * Salin konfigurasi yang sedang berlaku ke penyimpanan permanen, sekali saja.
 *
 * Ini adalah jembatan untuk instalasi yang sudah berjalan. Sebelum perubahan
 * ini, admin menyimpan kebijakan ke `/app/config`; pada deploy berikutnya isi
 * folder tersebut kembali ke nilai bawaan image dan penyetelannya hilang.
 * Menyalin apa yang sedang berlaku ke `db/runtime-config/` pada start pertama
 * membekukan kondisi baik itu di volume yang benar-benar bertahan — sebelum
 * build berikutnya sempat menimpanya.
 *
 * Idempoten: berkas runtime yang sudah ada tidak pernah disentuh, jadi hasil
 * penyimpanan admin selalu menang atas nilai bawaan image. Untuk sengaja
 * kembali ke bawaan, hapus berkasnya dari `db/runtime-config/`.
 */
export function ensureRuntimeConfigSeeded(): void {
  if (seeded) return;
  seeded = true;
  try {
    fs.mkdirSync(RUNTIME_CONFIG_DIR, { recursive: true });
  } catch {
    // Volume read-only: aplikasi tetap jalan memakai seed, dan halaman
    // Pengaturan menampilkan peringatan lewat configStorageInfo().
    return;
  }
  for (const basename of SEEDABLE_FILES) {
    const runtime = runtimeConfigFile(basename);
    const seed = seedConfigFile(basename);
    if (fs.existsSync(runtime) || !fs.existsSync(seed)) continue;
    try {
      // `flag: "wx"` supaya dua proses yang start bersamaan tidak saling timpa.
      // Mode 0o644 mempertahankan keterbacaan berkas asalnya di image: worker
      // sinkronisasi Python membaca superset-sync.json dari folder yang sama
      // dan pada sebagian deployment berjalan sebagai pengguna berbeda.
      fs.writeFileSync(runtime, fs.readFileSync(seed), { flag: "wx", mode: 0o644 });
      console.info(`[WIOM] Konfigurasi ${basename} dipindahkan ke penyimpanan permanen ${runtime}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      console.warn(`[WIOM] ${basename} tidak dapat dipindahkan ke penyimpanan permanen: ${(error as Error).message}`);
    }
  }
}

/**
 * Ringkasan status penyimpanan konfigurasi.
 *
 * Dipakai halaman Pengaturan dan endpoint kesiapan supaya operator dapat
 * memastikan — sebelum deploy berikutnya, bukan sesudahnya — bahwa folder
 * permanen benar-benar dapat ditulis.
 */
export function configStorageInfo(): ConfigStorageInfo {
  const persisted: string[] = [];
  const usingSeed: string[] = [];
  for (const basename of MANAGED_FILES) {
    if (isPersisted(basename)) persisted.push(basename);
    else usingSeed.push(basename);
  }
  const probe = probeWritable();
  return {
    runtimeDir: RUNTIME_CONFIG_DIR,
    seedDir: SEED_CONFIG_DIR,
    writable: probe.writable,
    persisted,
    usingSeed,
    reason: probe.reason,
  };
}

/**
 * Uji tulis, disimpan sebentar.
 *
 * Healthcheck container memanggil `/api/ready` tiap 15 detik. Menulis dan
 * menghapus berkas uji sesering itu menambah I/O pada volume tanpa memberi
 * informasi baru — izin folder tidak berubah tiap 15 detik. Satu menit cukup
 * cepat untuk menangkap volume yang berubah menjadi read-only, dan cukup jarang
 * untuk tidak terasa.
 */
const PROBE_TTL_MS = 60_000;
let probeCache: { at: number; writable: boolean; reason?: string } | null = null;

function probeWritable(): { writable: boolean; reason?: string } {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) {
    return { writable: probeCache.writable, reason: probeCache.reason };
  }
  let result: { writable: boolean; reason?: string };
  try {
    fs.mkdirSync(RUNTIME_CONFIG_DIR, { recursive: true });
    const probe = path.join(RUNTIME_CONFIG_DIR, `.write-probe.${process.pid}`);
    fs.writeFileSync(probe, "ok", { mode: 0o600 });
    fs.rmSync(probe, { force: true });
    result = { writable: true };
  } catch (probeError) {
    // Hanya kode errno-nya. Pesan lengkapnya memuat path absolut di server.
    result = {
      writable: false,
      reason: (probeError as NodeJS.ErrnoException).code || "UNKNOWN",
    };
    console.error(
      `[WIOM] Penyimpanan konfigurasi ${RUNTIME_CONFIG_DIR} tidak dapat ditulis: ${(probeError as Error).message}`,
    );
  }
  probeCache = { at: Date.now(), ...result };
  return result;
}
