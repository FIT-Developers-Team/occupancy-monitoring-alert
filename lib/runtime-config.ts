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
 * Jangan biarkan API Settings sukses menulis ke filesystem container yang
 * diketahui ephemeral. Readiness tetap memberi diagnosis; guard ini mencegah
 * false-success bila trafik masih sempat mencapai container yang tidak sehat.
 */
export function assertDurableConfigStorage(): void {
  const required = ["1", "true", "on", "required"].includes(
    process.env.WIOM_REQUIRE_PERSISTENT_STORAGE?.trim().toLowerCase() || "",
  );
  if (required && detectPersistentMount() !== true) {
    throw new Error(
      "Penyimpanan persisten belum terpasang. Pasang named volume atau bind mount ke /app/db sebelum menyimpan konfigurasi.",
    );
  }
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
  for (const basename of MIGRATABLE_FILES) {
    const runtime = runtimeConfigFile(basename);
    const source = bootstrapConfigFile(basename);
    if (fs.existsSync(runtime) || !fs.existsSync(source)) continue;
    try {
      // `flag: "wx"` supaya dua proses yang start bersamaan tidak saling timpa.
      // Berkas yang memuat webhook/kredensial memakai 0o600; kebijakan publik
      // memakai 0o644 agar deployment service terpisah tetap dapat membacanya.
      fs.writeFileSync(runtime, fs.readFileSync(source), {
        flag: "wx",
        mode: PRIVATE_FILES.has(basename) ? 0o600 : 0o644,
      });
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
  const durabilityRequired = ["1", "true", "on", "required"].includes(
    process.env.WIOM_REQUIRE_PERSISTENT_STORAGE?.trim().toLowerCase() || "",
  );
  return {
    runtimeDir: RUNTIME_CONFIG_DIR,
    seedDir: SEED_CONFIG_DIR,
    legacyDir: LEGACY_CONFIG_DIR,
    writable: probe.writable,
    persistentMount,
    durabilityRequired,
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
