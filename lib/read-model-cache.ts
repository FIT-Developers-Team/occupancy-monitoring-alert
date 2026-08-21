import fs from "node:fs";
import path from "node:path";

interface CacheEnvelope<T> {
  version: string;
  updatedAt: number;
  data: T;
}

const CACHE_DIR = path.join(process.cwd(), "db", "read-model-cache");
const memory = new Map<string, CacheEnvelope<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

function fileFor(key: string): string {
  const safe = key.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return path.join(CACHE_DIR, `${safe || "read-model"}.json`);
}

function loadEnvelope<T>(key: string): CacheEnvelope<T> | null {
  const fromMemory = memory.get(key) as CacheEnvelope<T> | undefined;
  if (fromMemory) return fromMemory;
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(key), "utf8")) as CacheEnvelope<T>;
    if (!parsed || typeof parsed.updatedAt !== "number" || typeof parsed.version !== "string") return null;
    memory.set(key, parsed as CacheEnvelope<unknown>);
    return parsed;
  } catch {
    return null;
  }
}

function saveEnvelope<T>(key: string, envelope: CacheEnvelope<T>): void {
  memory.set(key, envelope as CacheEnvelope<unknown>);
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const file = fileFor(key);
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(envelope), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    // Cache persistence is an optimisation. Keep the valid in-memory result
    // even if a read-only or full volume prevents writing the disposable copy.
    console.warn(`[WIOM] Read-model cache ${key} tidak dapat disimpan: ${(error as Error).message}`);
  }
}

/**
 * Persistent cache for expensive, read-only dashboard models.
 *
 * Two different things can make a cached result obsolete, and they do not
 * deserve the same answer:
 *
 *   - The **version** changed. It carries the fingerprint of the DuckDB file
 *     plus the active policy, so a different value means a newer snapshot is
 *     already on disk and the cached numbers are known to be wrong. This waits
 *     for the real result.
 *   - Only the **age** ran out. The snapshot behind the cached result has not
 *     moved, so the copy is still a correct answer to the same question. It is
 *     served immediately and refreshed in the background.
 *
 * The distinction is the whole point: treating both as "stale" meant the first
 * request after every sync rendered figures one cycle behind, even though the
 * fresh data was sitting right there and the version key already knew it.
 *
 * A failed recompute still falls back to the last valid result — a snapshot one
 * cycle old beats an error boundary, which is what the sync worker's write
 * window would otherwise produce. Cache files live on the existing /app/db
 * volume and never contain credentials or account records.
 */
export async function readModelCached<T>(
  key: string,
  version: string,
  loader: () => Promise<T>,
  options: { freshMs?: number } = {},
): Promise<T> {
  const freshMs = options.freshMs ?? 5 * 60_000;
  const cached = loadEnvelope<T>(key);
  const sameVersion = cached ? cached.version === version : false;
  if (cached && sameVersion && Date.now() - cached.updatedAt < freshMs) return cached.data;

  let refresh = inFlight.get(key) as Promise<T> | undefined;
  if (!refresh) {
    refresh = loader()
      .then((data) => {
        saveEnvelope(key, { version, updatedAt: Date.now(), data });
        return data;
      })
      .finally(() => { inFlight.delete(key); });
    inFlight.set(key, refresh);
  }

  if (cached && sameVersion) {
    // Same snapshot, same policy — only the age ran out. Prevent the detached
    // refresh from surfacing as an unhandled rejection; the next request
    // retries while the last valid data remains on screen.
    void refresh.catch((error) => {
      console.warn(`[WIOM] Refresh read model ${key} gagal: ${(error as Error).message}`);
    });
    return cached.data;
  }

  try {
    return await refresh;
  } catch (error) {
    if (!cached) throw error;
    // Dibedakan dari peringatan di atas dengan sengaja. Di sini sidik jari
    // datanya SUDAH berganti, jadi hasil yang tersaji diketahui berasal dari
    // snapshot lama — bukan sekadar hasil yang umurnya lewat. Tanpa umur yang
    // disebutkan, kegagalan berulang terbaca sama saja dengan kegagalan sekali,
    // dan sebuah read model dapat tertinggal berjam-jam di belakang sisa dasbor
    // tanpa satu pun barisnya menunjukkan hal itu. Persis itulah yang terjadi
    // pada read model tren: ia gagal setiap kali dan tetap tersaji, 22 jam di
    // belakang setiap angka lain di layar.
    console.error(
      `[WIOM] Read model ${key} gagal dihitung ulang (${(error as Error).message})`
      + ` — menyajikan hasil ${describeAge(Date.now() - cached.updatedAt)} dari snapshot sebelumnya.`,
    );
    return cached.data;
  }
}

function describeAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} jam lalu` : `${Math.round(hours / 24)} hari lalu`;
}

export function clearReadModelMemory(): void {
  memory.clear();
}
