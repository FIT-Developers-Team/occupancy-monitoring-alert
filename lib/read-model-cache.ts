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
 * Persistent stale-while-revalidate for expensive, read-only dashboard models.
 *
 * A last valid result is returned immediately while a newer Superset snapshot
 * is being aggregated in the background. The first ever read still waits for
 * a real query; no fabricated data is served. Cache files live on the existing
 * /app/db volume and never contain credentials or account records.
 */
export async function readModelCached<T>(
  key: string,
  version: string,
  loader: () => Promise<T>,
  options: { freshMs?: number } = {},
): Promise<T> {
  const freshMs = options.freshMs ?? 5 * 60_000;
  const cached = loadEnvelope<T>(key);
  const isFresh = cached && cached.version === version && Date.now() - cached.updatedAt < freshMs;
  if (isFresh) return cached.data;

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

  if (cached) {
    // Prevent an intentionally detached refresh from surfacing as an unhandled
    // rejection. The next request retries while the last valid data remains.
    void refresh.catch((error) => {
      console.warn(`[WIOM] Refresh read model ${key} gagal: ${(error as Error).message}`);
    });
    return cached.data;
  }
  return refresh;
}

export function clearReadModelMemory(): void {
  memory.clear();
}
