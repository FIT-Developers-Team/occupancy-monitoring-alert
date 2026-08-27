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
// `db/` adalah satu-satunya batas penyimpanan permanen aplikasi: history
// DuckDB, state alert, akun, secret sesi, dan konfigurasi runtime hidup di
// sana. Karena itu seluruh konfigurasi runtime ditulis ke
// `<folder state DuckDB>/runtime-config/`. `config/` hanya menjadi sumber
// migrasi instalasi lama; default asli image berada di `default-config/` agar
// volume `/app/config` lama tidak menutupi default yang ikut versi aplikasi.
//
// Aturan baca/tulis:
//   baca  : runtime > konfigurasi legacy > default immutable image
//   tulis : selalu ke folder runtime
//
// Efeknya: instalasi lama tetap terbaca apa adanya (fallback), penyimpanan
// pertama memindahkannya ke volume permanen, dan deploy berikutnya tidak lagi
// menimpa apa pun yang sudah disimpan.
import fs from "node:fs";
import path from "node:path";
import { checkConfigCoherence, checkConfigFile } from "@/lib/config-schema";

const ROOT = process.cwd();

/**
 * Konfigurasi instalasi lama yang mungkin masih dipasang sebagai `/app/config`.
 * Folder ini hanya dibaca untuk migrasi; semua penyimpanan baru masuk runtime.
 */
export const LEGACY_CONFIG_DIR = process.env.WIOM_LEGACY_CONFIG_DIR?.trim()
  ? path.resolve(process.env.WIOM_LEGACY_CONFIG_DIR.trim())
  : path.join(ROOT, "config");

/** Default immutable yang dikemas bersama image mulai kontrak storage v2. */
export const BUNDLED_CONFIG_DIR = process.env.WIOM_BUNDLED_CONFIG_DIR?.trim()
  ? path.resolve(process.env.WIOM_BUNDLED_CONFIG_DIR.trim())
  : path.join(ROOT, "default-config");

/**
 * Nilai awal kanonik. Checkout lokal lama belum memiliki `default-config/`,
 * jadi `config/` tetap menjadi fallback kompatibel untuk dev/non-Docker.
 */
export const SEED_CONFIG_DIR = fs.existsSync(BUNDLED_CONFIG_DIR)
  ? BUNDLED_CONFIG_DIR
  : LEGACY_CONFIG_DIR;

function stateDirectory(): string {
  const statePath = process.env.DUCKDB_STATE_PATH?.trim();
  return statePath
    ? path.dirname(path.resolve(statePath))
    : path.join(ROOT, "db");
}

/**
 * Volume permanen. Bila `DUCKDB_STATE_PATH` dipindah, konfigurasi otomatis ikut
 * ke volume state yang sama; `WIOM_RUNTIME_CONFIG_DIR` tetap menjadi override
 * eksplisit untuk deployment khusus.
 */
export const RUNTIME_CONFIG_DIR = process.env.WIOM_RUNTIME_CONFIG_DIR?.trim()
  ? path.resolve(process.env.WIOM_RUNTIME_CONFIG_DIR.trim())
  : path.join(stateDirectory(), "runtime-config");

/** Lokasi tulis kanonik untuk sebuah berkas konfigurasi. */
export function runtimeConfigFile(basename: string): string {
  return path.join(RUNTIME_CONFIG_DIR, basename);
}

/** Nilai awal bawaan image untuk sebuah berkas konfigurasi. */
export function seedConfigFile(basename: string): string {
  return path.join(SEED_CONFIG_DIR, basename);
}

/** Berkas instalasi lama, bila masih ada pada volume `/app/config`. */
export function legacyConfigFile(basename: string): string {
  return path.join(LEGACY_CONFIG_DIR, basename);
}

/**
 * Sumber bootstrap dengan precedence yang menjaga upgrade:
 * konfigurasi legacy yang pernah disimpan admin > default immutable image.
 */
function bootstrapConfigFile(basename: string): string {
  const legacy = legacyConfigFile(basename);
  if (fs.existsSync(legacy)) return legacy;
  return seedConfigFile(basename);
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
  return fs.existsSync(runtime) ? runtime : bootstrapConfigFile(basename);
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
  assertDurableConfigStorage();
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

/**
 * Seberapa keras deployment ini menuntut bukti penyimpanan permanen.
 *
 *   "off"      — tidak dituntut (checkout dev, non-Docker).
 *   "required" — dituntut dan dilaporkan keras, tetapi aplikasi tetap jalan.
 *   "strict"   — penyimpanan konfigurasi ditolak selama mount belum terbukti.
 *
 * Bawaan image adalah "required", BUKAN "strict", dan itu perbedaan yang
 * pernah menjatuhkan satu deployment: dengan "strict", container tanpa volume
 * tidak dapat menulis apa pun — termasuk bootstrap akun admin pertama — jadi
 * readiness tidak pernah hijau, Coolify menggulung balik, dan satu-satunya
 * tempat memperbaiki keadaan (halaman Pengaturan) ikut mati bersamanya.
 * Aplikasi yang hidup dengan peringatan keras selalu lebih dapat diperbaiki
 * daripada aplikasi yang menolak menyala.
 *
 * "strict" tetap tersedia untuk operator yang memang ingin deploy gagal
 * daripada berjalan di atas penyimpanan sementara.
 */
export type PersistenceMode = "off" | "required" | "strict";

export function persistenceMode(): PersistenceMode {
  const raw = process.env.WIOM_REQUIRE_PERSISTENT_STORAGE?.trim().toLowerCase() || "";
  if (["strict", "block", "enforce"].includes(raw)) return "strict";
  if (["1", "true", "on", "required", "warn"].includes(raw)) return "required";
  return "off";
}

/**
 * Tolak penyimpanan hanya pada mode "strict".
 *
 * Pada mode "required" penyimpanan tetap dilanjutkan: nilainya benar-benar
 * tersimpan dan langsung berlaku, hanya belum tahan terhadap penggantian
 * container. Kondisi itu dilaporkan configStorageInfo(), /api/ready, banner
 * halaman Pengaturan, dan log start-up — bukan disembunyikan.
 */
export function assertDurableConfigStorage(): void {
  if (persistenceMode() !== "strict") return;
  if (detectPersistentMount() === true) return;
  throw new Error(
    "Penyimpanan persisten belum terpasang. Pasang named volume atau bind mount ke /app/db sebelum menyimpan konfigurasi.",
  );
}

export interface ConfigStorageInfo {
  /** Folder tempat setiap penyimpanan admin mendarat. */
  runtimeDir: string;
  /** Folder nilai awal bawaan image. */
  seedDir: string;
  /** Folder konfigurasi deployment lama yang hanya dibaca untuk migrasi. */
  legacyDir: string;
  /** Folder runtime benar-benar dapat ditulis oleh proses ini. */
  writable: boolean;
  /** Folder runtime berada pada mount terpisah dari filesystem container. */
  persistentMount: boolean | null;
  /** Deployment ini mewajibkan bukti mount persisten (image Docker produksi). */
  durabilityRequired: boolean;
  /** Penyimpanan ditolak selama mount belum terbukti (mode "strict"). */
  durabilityEnforced: boolean;
  /** Storage siap dipakai tanpa risiko reset container yang diketahui. */
  durable: boolean;
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
  "sku-standards.json",
  "recipients.json",
  "superset-sync.json",
  ".superset-sync.secrets.json",
  "accounts.json",
];

/** Seksi yang punya nilai awal di image dan wajib diamankan sebelum deploy berikutnya. */
const SEEDABLE_FILES = [
  "thresholds.json",
  "rules.json",
  "warehouses.json",
  "capacity.json",
  "sku-standards.json",
  "recipients.json",
  "superset-sync.json",
];

/**
 * Sidecar kredensial tidak pernah ada di source control, tetapi dapat berada
 * di volume `/app/config` milik deployment lama. Ia wajib ikut dimigrasikan.
 */
const LEGACY_ONLY_FILES = [".superset-sync.secrets.json"];
const MIGRATABLE_FILES = [...SEEDABLE_FILES, ...LEGACY_ONLY_FILES];

const PRIVATE_FILES = new Set([
  "recipients.json",
  "superset-sync.json",
  ".superset-sync.secrets.json",
  "accounts.json",
]);

// ---- Cadangan konfigurasi ---------------------------------------------------
//
// KENAPA ADA
// ----------
// Volume permanen tetap merupakan jawaban yang benar, tetapi memasangnya pada
// aplikasi yang sudah berjalan dulu menuntut akses Docker: `docker cp` untuk
// menyelamatkan isi container lama sebelum mount kosong menutupinya. Operator
// yang hanya memegang panel Coolify tidak punya jalan itu, sehingga satu-satunya
// pilihan yang tersisa adalah mengetik ulang seluruh Pengaturan setelah setiap
// deploy — persis keluhan "sangat manual dan ribet".
//
// Dua jalur di bawah menghapus ketergantungan itu:
//   1. Unduh/pulihkan berkas cadangan langsung dari halaman Pengaturan.
//   2. `WIOM_CONFIG_BUNDLE` — nilai cadangan yang sama disimpan sebagai
//      environment variable. Environment Coolify bertahan melewati deploy,
//      sehingga konfigurasi ikut pulih sendiri bahkan tanpa volume sama sekali.
//
// Keduanya memakai satu format yang sama, dan keduanya tidak pernah menimpa
// berkas runtime yang sudah ada kecuali pemulihan diminta secara eksplisit.

/** Nama environment variable berisi cadangan konfigurasi (JSON atau base64). */
export const CONFIG_BUNDLE_ENV = "WIOM_CONFIG_BUNDLE";

export interface ConfigBundle {
  version: 1;
  created_at: string;
  files: Record<string, unknown>;
}

function decodeBundleText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Cadangan konfigurasi kosong.");
  // Nilai environment lebih aman dalam bentuk base64 (satu baris, tanpa kutip
  // yang perlu di-escape), tetapi berkas unduhan tetap JSON biasa agar dapat
  // dibaca manusia. Keduanya diterima.
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  return JSON.parse(Buffer.from(trimmed, "base64").toString("utf8"));
}

/** Satu berkas cadangan yang ditolak, beserta alasan yang dapat dibaca admin. */
export interface RejectedConfigFile {
  file: string;
  reason: string;
}

export interface ParsedConfigBundle {
  bundle: ConfigBundle;
  /** Berkas yang gagal diperiksa — kosong pada mode "strict" (ia melempar). */
  rejected: RejectedConfigFile[];
}

/**
 * Validasi cadangan sebelum satu byte pun ditulis.
 *
 * DUA LAPIS, DAN KEDUANYA PERNAH DIBUTUHKAN
 * -----------------------------------------
 * 1. Nama berkas TIDAK pernah dipercaya apa adanya: hanya nama yang ada pada
 *    daftar terkelola yang diterima, sehingga cadangan yang dibuat-buat tidak
 *    dapat menulis ke path lain melalui `..` atau nama tak dikenal.
 * 2. ISI setiap berkas diperiksa terhadap skemanya. Lapis ini dulu tidak ada,
 *    dan tanpanya sebuah cadangan yang bentuknya sudah tidak cocok — unduhan
 *    dari versi aplikasi lama, berkas yang disunting tangan, unduhan yang
 *    terpotong — tetap ditulis ke volume. Pembacaan konfigurasi berikutnya
 *    melempar, dan karena SETIAP halaman membaca kebijakan sebelum dirender,
 *    seluruh aplikasi berubah menjadi layar galat. Termasuk halaman Pengaturan,
 *    yaitu satu-satunya tempat keadaan itu dapat diperbaiki.
 *
 * Mode "strict" (pemulihan manual dari berkas) menolak seluruh cadangan begitu
 * ada satu berkas yang tidak sah — memulihkan sebagian diam-diam justru
 * meninggalkan konfigurasi campuran yang tidak pernah diminta siapa pun.
 * Mode "lenient" (`WIOM_CONFIG_BUNDLE` saat start-up) melewati berkas yang
 * bermasalah dan mencatatnya, karena di sana alternatifnya adalah container
 * yang gagal menyala.
 */
export function parseConfigBundle(input: unknown, mode: "strict" | "lenient" = "strict"): ConfigBundle {
  return parseConfigBundleDetailed(input, mode).bundle;
}

export function parseConfigBundleDetailed(
  input: unknown,
  mode: "strict" | "lenient" = "strict",
): ParsedConfigBundle {
  const raw = typeof input === "string" ? decodeBundleText(input) : input;
  if (!raw || typeof raw !== "object") {
    throw new Error("Cadangan konfigurasi tidak dapat dibaca.");
  }
  const candidate = raw as Partial<ConfigBundle>;
  if (candidate.version !== 1 || !candidate.files || typeof candidate.files !== "object") {
    throw new Error("Format cadangan konfigurasi tidak dikenal.");
  }
  const files: Record<string, unknown> = {};
  const rejected: RejectedConfigFile[] = [];
  let sawKnownName = false;
  for (const [basename, value] of Object.entries(candidate.files)) {
    if (!MANAGED_FILES.includes(basename)) continue;
    sawKnownName = true;
    if (!value || typeof value !== "object") {
      const reason = `Isi ${basename} pada cadangan tidak valid.`;
      if (mode === "strict") throw new Error(reason);
      rejected.push({ file: basename, reason });
      continue;
    }
    try {
      // Nilai hasil parse yang disimpan, bukan masukan mentah: bidang yang
      // hilang terisi bawaannya, sehingga berkas yang mendarat di volume selalu
      // berbentuk yang dapat dibaca ulang aplikasi.
      files[basename] = checkConfigFile(basename, value);
    } catch (error) {
      const reason = `${basename}: ${(error as Error).message}`;
      if (mode === "strict") throw new Error(reason);
      rejected.push({ file: basename, reason });
    }
  }
  if (!sawKnownName) {
    throw new Error("Cadangan tidak memuat satu pun berkas konfigurasi yang dikenal.");
  }
  if (!Object.keys(files).length) {
    throw new Error(
      rejected.length
        ? `Tidak ada berkas cadangan yang lolos pemeriksaan. ${rejected[0].reason}`
        : "Cadangan tidak memuat satu pun berkas konfigurasi yang dikenal.",
    );
  }
  return {
    bundle: {
      version: 1,
      created_at: typeof candidate.created_at === "string" ? candidate.created_at : new Date().toISOString(),
      files,
    },
    rejected,
  };
}

/** Kumpulkan konfigurasi yang sedang BERLAKU, bukan hanya yang sudah permanen. */
export function exportConfigBundle(): ConfigBundle {
  const files: Record<string, unknown> = {};
  for (const basename of MANAGED_FILES) {
    const file = resolveConfigFile(basename);
    try {
      files[basename] = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // Berkas yang belum pernah ada (mis. akun pada instalasi baru) memang
      // tidak punya apa pun untuk dicadangkan.
    }
  }
  return { version: 1, created_at: new Date().toISOString(), files };
}

/** Nilai satu baris untuk ditempel ke environment variable deployment. */
export function encodeConfigBundle(bundle: ConfigBundle): string {
  return Buffer.from(JSON.stringify(bundle), "utf8").toString("base64");
}

/** Nama berkas salinan pengaman yang ditulis tepat sebelum sebuah pemulihan. */
export const PRE_RESTORE_SNAPSHOT = ".pre-restore-backup.json";

export interface RestoreOptions {
  /**
   * Ikut memulihkan `accounts.json`.
   *
   * Bawaannya TIDAK. Cadangan konfigurasi hampir selalu dipulihkan untuk
   * mengembalikan kebijakan, bukan daftar orang — dan berkas akun dari cadangan
   * lama menghapus setiap akun yang dibuat sesudahnya, termasuk akun admin yang
   * sedang login saat itu juga. Memindahkannya menjadi pilihan sadar membuat
   * "pulihkan pengaturan" tidak pernah lagi berarti "keluarkan saya dari
   * aplikasi ini".
   */
  includeAccounts?: boolean;
}

export interface RestoreReport {
  restored: string[];
  /** Berkas yang ada di cadangan tetapi sengaja tidak ditulis. */
  skipped: RejectedConfigFile[];
  /** Salinan keadaan sebelum pemulihan, bila berhasil dibuat. */
  snapshot?: string;
}

/**
 * Kapan salinan pengaman terakhir dibuat, bila ada.
 *
 * Salinan yang tidak dapat dijangkau dari antarmuka sama saja dengan tidak ada:
 * admin yang baru saja memulihkan berkas yang salah tidak punya akses shell ke
 * server — itulah justru alasan seluruh fitur cadangan ini dibuat. Halaman
 * Pengaturan memakai nilai ini untuk menawarkan "batalkan pemulihan terakhir".
 */
export function preRestoreSnapshotAt(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(runtimeConfigFile(PRE_RESTORE_SNAPSHOT), "utf8"));
    return typeof raw?.created_at === "string" ? raw.created_at : null;
  } catch {
    return null;
  }
}

/** Isi salinan pengaman terakhir, siap dikirim kembali lewat importConfigBundle. */
export function readPreRestoreSnapshot(): unknown {
  return JSON.parse(fs.readFileSync(runtimeConfigFile(PRE_RESTORE_SNAPSHOT), "utf8"));
}

/** Baca satu berkas konfigurasi yang sedang berlaku; undefined bila tak terbaca. */
function readEffectiveConfig(basename: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(resolveConfigFile(basename), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Pulihkan cadangan ke penyimpanan runtime.
 *
 * SATU TRANSAKSI, BUKAN SEDERET PENULISAN
 * ---------------------------------------
 * Versi sebelumnya menulis berkas satu per satu di dalam perulangan. Kegagalan
 * di berkas keempat — volume penuh, izin berubah, container dimatikan tepat di
 * situ — meninggalkan tiga berkas baru berdampingan dengan lima berkas lama,
 * yaitu konfigurasi campuran yang tidak pernah ada di mana pun dan tidak dapat
 * dijelaskan oleh siapa pun.
 *
 * Sekarang: seluruh isi diperiksa, keadaan lama disalin ke memori, semua
 * berkas ditulis, dan bila ada satu saja yang gagal, yang sudah terlanjur
 * ditulis dikembalikan ke isi semula. Ditambah satu salinan pengaman di
 * `.pre-restore-backup.json` supaya pemulihan yang berhasil tetapi ternyata
 * salah berkas masih punya jalan pulang.
 */
export function importConfigBundle(input: unknown, options: RestoreOptions = {}): RestoreReport {
  const bundle = parseConfigBundle(input, "strict");
  const skipped: RejectedConfigFile[] = [];

  const wanted: Record<string, unknown> = {};
  for (const [basename, value] of Object.entries(bundle.files)) {
    if (basename === "accounts.json" && !options.includeAccounts) {
      skipped.push({
        file: basename,
        reason: "Daftar akun tidak ikut dipulihkan (aktifkan secara eksplisit bila memang diinginkan).",
      });
      continue;
    }
    wanted[basename] = value;
  }
  if (!Object.keys(wanted).length) {
    throw new Error("Tidak ada berkas yang dipilih untuk dipulihkan.");
  }

  // Invarian lintas berkas dinilai pada bentuk GABUNGAN sesudah pemulihan:
  // cadangan yang hanya memuat kapasitas tetap harus cocok dengan daftar gudang
  // yang bertahan di volume.
  const effective: Record<string, unknown> = {};
  for (const basename of SEEDABLE_FILES) {
    const value = basename in wanted ? wanted[basename] : readEffectiveConfig(basename);
    if (value !== undefined) effective[basename] = value;
  }
  const problems = checkConfigCoherence(effective);
  if (problems.length) throw new Error(problems.join(" "));

  assertDurableConfigStorage();
  fs.mkdirSync(RUNTIME_CONFIG_DIR, { recursive: true });

  // Salinan pengaman ditulis sebelum apa pun disentuh. Kegagalannya tidak
  // membatalkan pemulihan: sebuah volume yang tidak dapat menampung satu berkas
  // tambahan tetap harus bisa memperbaiki konfigurasi yang rusak.
  let snapshot: string | undefined;
  try {
    const before = exportConfigBundle();
    const file = runtimeConfigFile(PRE_RESTORE_SNAPSHOT);
    fs.writeFileSync(file, `${JSON.stringify(before, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    snapshot = PRE_RESTORE_SNAPSHOT;
  } catch (error) {
    console.warn(`[WIOM] Salinan pengaman sebelum pemulihan gagal dibuat: ${(error as Error).message}`);
  }

  // `null` = berkas belum ada, `undefined` = ada tetapi tidak terbaca.
  // Yang tidak terbaca tidak dapat dikembalikan, tetapi ia juga tidak boleh
  // membatalkan pemulihan sebelum dimulai: kegagalan sesungguhnya akan muncul
  // saat penulisan, dan di sana rollback berkas LAIN tetap harus berjalan.
  const previous = new Map<string, Buffer | null | undefined>();
  for (const basename of Object.keys(wanted)) {
    const file = runtimeConfigFile(basename);
    try {
      previous.set(basename, fs.existsSync(file) ? fs.readFileSync(file) : null);
    } catch {
      previous.set(basename, undefined);
    }
  }

  const written: string[] = [];
  try {
    for (const [basename, value] of Object.entries(wanted)) {
      writeConfigJsonAtomic(
        runtimeConfigFile(basename),
        value,
        PRIVATE_FILES.has(basename) ? 0o600 : 0o644,
      );
      written.push(basename);
    }
  } catch (error) {
    for (const basename of written) {
      const file = runtimeConfigFile(basename);
      const original = previous.get(basename);
      try {
        if (original === null) fs.rmSync(file, { force: true });
        else if (original) fs.writeFileSync(file, original, { mode: PRIVATE_FILES.has(basename) ? 0o600 : 0o644 });
      } catch (rollbackError) {
        console.error(`[WIOM] Pengembalian ${basename} setelah pemulihan gagal: ${(rollbackError as Error).message}`);
      }
    }
    throw new Error(`Pemulihan dibatalkan dan konfigurasi lama dikembalikan: ${(error as Error).message}`);
  }

  return { restored: written, skipped, snapshot };
}

/**
 * Isi cadangan dari environment, atau kosong bila tidak ada/tidak sahih.
 *
 * Mode "lenient": satu berkas yang bentuknya tidak lagi cocok hanya
 * dilewatkan — seksi itu memakai bawaan image dan alasannya masuk log deploy —
 * alih-alih ditulis ke volume dan mematikan aplikasi pada permintaan pertama.
 * Berkas yang ditulis di sini bertahan selamanya (seed tidak pernah menimpa
 * berkas runtime yang sudah ada), jadi inilah satu-satunya kesempatan
 * memeriksanya.
 */
function envBundleFiles(): Record<string, unknown> {
  const raw = process.env[CONFIG_BUNDLE_ENV]?.trim();
  if (!raw) return {};
  try {
    const { bundle, rejected } = parseConfigBundleDetailed(raw, "lenient");
    for (const entry of rejected) {
      console.warn(`[WIOM] ${CONFIG_BUNDLE_ENV} — ${entry.reason} Seksi ini memakai nilai bawaan image.`);
    }
    return bundle.files;
  } catch (error) {
    // Cadangan yang rusak tidak boleh menghentikan start-up: aplikasi tetap
    // menyala memakai nilai bawaan, dan alasannya tercatat di log deploy.
    console.warn(`[WIOM] ${CONFIG_BUNDLE_ENV} diabaikan: ${(error as Error).message}`);
    return {};
  }
}

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
  // Urutan sumber, dari yang paling berhak:
  //   berkas runtime yang sudah ada > cadangan environment > konfigurasi
  //   legacy > default bawaan image.
  //
  // Cadangan environment berada di atas legacy dan default karena ia adalah
  // hasil penyimpanan admin yang sengaja diawetkan untuk melewati deploy;
  // menaruhnya di bawah default berarti ia tidak pernah terpakai.
  const fromEnv = envBundleFiles();
  const wanted = [...new Set([...MIGRATABLE_FILES, ...Object.keys(fromEnv)])];
  for (const basename of wanted) {
    const runtime = runtimeConfigFile(basename);
    if (fs.existsSync(runtime)) continue;
    // `flag: "wx"` supaya dua proses yang start bersamaan tidak saling timpa.
    // Berkas yang memuat webhook/kredensial memakai 0o600; kebijakan publik
    // memakai 0o644 agar deployment service terpisah tetap dapat membacanya.
    const mode = PRIVATE_FILES.has(basename) ? 0o600 : 0o644;
    const envValue = fromEnv[basename];
    if (envValue !== undefined) {
      try {
        fs.writeFileSync(runtime, `${JSON.stringify(envValue, null, 2)}\n`, { flag: "wx", mode });
        console.info(`[WIOM] Konfigurasi ${basename} dipulihkan dari ${CONFIG_BUNDLE_ENV}`);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        console.warn(`[WIOM] ${basename} tidak dapat dipulihkan dari ${CONFIG_BUNDLE_ENV}: ${(error as Error).message}`);
      }
    }
    const source = bootstrapConfigFile(basename);
    if (!fs.existsSync(source)) continue;
    try {
      fs.writeFileSync(runtime, fs.readFileSync(source), { flag: "wx", mode });
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
  const persistentMount = detectPersistentMount();
  const mode = persistenceMode();
  const durabilityRequired = mode !== "off";
  return {
    runtimeDir: RUNTIME_CONFIG_DIR,
    seedDir: SEED_CONFIG_DIR,
    legacyDir: LEGACY_CONFIG_DIR,
    writable: probe.writable,
    persistentMount,
    durabilityRequired,
    durabilityEnforced: mode === "strict",
    durable: probe.writable && (!durabilityRequired || persistentMount === true),
    persisted,
    usingSeed,
    reason: probe.reason,
  };
}

function decodeMountPath(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_match, code: string) => ({
    "040": " ",
    "011": "\t",
    "012": "\n",
    "134": "\\",
  })[code] || _match);
}

function directoryContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Verifikasi mount Linux dari `/proc/self/mountinfo`.
 *
 * Writable saja tidak membuktikan persistence: filesystem container juga
 * writable tetapi hilang ketika Coolify mengganti container. Image produksi
 * mengaktifkan `WIOM_REQUIRE_PERSISTENT_STORAGE`, sehingga readiness hanya OK
 * bila direktori runtime berada di mount eksternal (named volume/bind mount).
 * Di dev non-Linux hasilnya `null` dan pemeriksaan tidak diwajibkan.
 */
export function persistentMountFromInfo(
  mountInfo: string,
  directory = RUNTIME_CONFIG_DIR,
): boolean {
  const target = path.resolve(directory);
  let best: { mountPoint: string; fsType: string } | null = null;
  for (const line of mountInfo.split(/\r?\n/)) {
    const [left, right] = line.split(" - ");
    if (!left || !right) continue;
    const fields = left.trim().split(/\s+/);
    const after = right.trim().split(/\s+/);
    if (fields.length < 5 || after.length < 1) continue;
    const mountPoint = path.resolve(decodeMountPath(fields[4]));
    if (!directoryContains(mountPoint, target)) continue;
    if (!best || mountPoint.length > best.mountPoint.length) {
      best = { mountPoint, fsType: after[0] };
    }
  }
  if (!best) return false;
  const filesystemRoot = path.parse(best.mountPoint).root;
  return best.mountPoint !== filesystemRoot && !["tmpfs", "ramfs"].includes(best.fsType);
}

function detectPersistentMount(): boolean | null {
  if (process.platform !== "linux") return null;
  try {
    return persistentMountFromInfo(fs.readFileSync("/proc/self/mountinfo", "utf8"));
  } catch {
    return null;
  }
}

/**
 * Uji tulis, disimpan sebentar.
 *
 * Monitoring memanggil `/api/ready` sesering healthcheck. Menulis dan
 * menghapus berkas uji sesering itu menambah I/O pada volume tanpa memberi
 * informasi baru — izin folder tidak berubah tiap belasan detik. Satu menit cukup
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
