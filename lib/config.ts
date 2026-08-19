// Config-driven policy layer: thresholds, rules, recipients, warehouses, capacity.
import fs from "fs";
import { z } from "zod";
import {
  googleChatSpaceOf,
  isGoogleChatWebhookUrl,
  normalizeGoogleChatMentionId,
  normalizeGoogleChatThreadName,
} from "@/lib/notify/gchat-url";
import { ensureRuntimeConfigSeeded, resolveConfigFile, writeConfigJsonAtomic } from "@/lib/runtime-config";

// Dijalankan sekali per proses, saat modul kebijakan pertama kali dimuat —
// yaitu sebelum permintaan apa pun sempat membaca konfigurasi.
ensureRuntimeConfigSeeded();

/**
 * Setiap seksi kebijakan disimpan di volume permanen, bukan di dalam image.
 *
 * Sebelumnya hanya `recipients` yang diperlakukan begitu; sisanya ditulis ke
 * `config/*.json` yang ikut dibangun ke image, sehingga ambang, kapasitas, dan
 * daftar gudang yang sudah disimpan admin kembali ke nilai bawaan pada deploy
 * berikutnya. Lihat lib/runtime-config.ts untuk aturan baca/tulis.
 */
function sectionFile(section: ConfigSection, forWrite = false): string {
  return resolveConfigFile(`${section}.json`, forWrite);
}

export const SEVERITY_LEVELS = ["INFO", "WARNING", "HIGH", "CRITICAL", "EMERGENCY"] as const;
const SeverityEnum = z.enum(SEVERITY_LEVELS);

const ThresholdSchema = z.object({
  default: z.object({
    monitor: z.number(), warning: z.number(), critical: z.number(), breach: z.number(),
    hysteresis_buffer: z.number().default(3),
  }),
  overrides: z.record(z.string(), z.object({
    monitor: z.number().optional(), warning: z.number().optional(),
    critical: z.number().optional(), breach: z.number().optional(),
    hysteresis_buffer: z.number().optional(),
  })).default({}),
  /**
   * Per-location alerts. A warehouse has ~144k active SLOCs and roughly 700 sit
   * over their qty capacity at any moment, so this is deliberately capped: only
   * the worst `max_alerts` locations above `min_pct` raise an alert per pass.
   * Without the cap one tick would post hundreds of cards into the Space.
   */
  sloc_alerts: z.object({
    enabled: z.boolean().default(true),
    min_pct: z.number().min(100).max(1000).default(110),
    max_alerts: z.number().int().min(1).max(200).default(20),
  }).default({}),
  /**
   * Bagaimana kelebihan kapasitas diterjemahkan menjadi tingkat keparahan.
   *
   * Ambang di atas menjawab "kapan sebuah lokasi/zona layak diberi alert".
   * Blok ini menjawab pertanyaan yang berbeda dan lebih tajam: SEBERAPA buruk
   * kondisinya. Satu basis melebihi kapasitas masih bisa berarti data master
   * yang salah pada basis itu; Qty DAN CBM sama-sama melebihi kapasitas berarti
   * lokasinya memang benar-benar penuh, dan itu tidak boleh berbagi tingkat
   * keparahan dengan kasus pertama.
   *
   * Dibuat dapat diatur, bukan ditanam di kode, karena batas antara "perlu
   * dirapikan" dan "hentikan inbound" adalah keputusan operasional yang berbeda
   * di setiap gudang.
   */
  overflow_severity: z.object({
    /** Persentase yang dianggap "melebihi kapasitas". 100 = tepat di kapasitas. */
    over_pct: z.number().min(100).max(1000).default(100),
    /** Qty ATAU CBM melebihi kapasitas, sementara keduanya terukur. */
    single_basis: SeverityEnum.default("CRITICAL"),
    /** Qty DAN CBM sama-sama melebihi kapasitas. */
    dual_basis: SeverityEnum.default("EMERGENCY"),
    /**
     * Hanya satu dari dua basis yang punya kapasitas sahih.
     *
     * Di sini "Qty dan CBM sama-sama lewat" tidak akan pernah dapat dibuktikan,
     * jadi menaikkannya ke tingkat tertinggi berarti menghukum lubang di data
     * master, bukan kondisi gudang. Bawaannya sengaja sama dengan satu basis.
     */
    single_measurable: SeverityEnum.default("CRITICAL"),
    /** Ambang breach terlampaui tetapi belum ada basis yang melebihi kapasitas. */
    threshold_only: SeverityEnum.default("HIGH"),
  }).default({}),
}).superRefine((value, ctx) => {
  const check = (v: { monitor?: number; warning?: number; critical?: number; breach?: number }, path: (string | number)[]) => {
    const values = [v.monitor, v.warning, v.critical, v.breach];
    if (values.every((n) => n !== undefined) && !(values[0]! <= values[1]! && values[1]! <= values[2]! && values[2]! <= values[3]!)) {
      ctx.addIssue({ code: "custom", path, message: "Ambang harus berurutan: monitor ≤ warning ≤ critical ≤ breach." });
    }
  };
  check(value.default, ["default"]);
  for (const [wh, override] of Object.entries(value.overrides)) {
    check({ ...value.default, ...override }, ["overrides", wh]);
  }
});

const RulesSchema = z.object({
  rules: z.array(z.object({
    id: z.string(), name: z.string(), category: z.string(),
    severity: SeverityEnum,
    enabled: z.boolean(), params: z.record(z.string(), z.any()).default({}),
    description: z.string().default(""),
  })),
});

const GoogleChatRouteSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  warehouse_codes: z.array(z.string().trim().min(1).max(20)).min(1).default(["*"]),
  webhook_url: z.string().url().refine(isGoogleChatWebhookUrl, {
    message: "Webhook Google Chat harus memakai URL incoming webhook chat.googleapis.com yang lengkap.",
  }),
  // Who to tag for these warehouses. Work email is the expected form; numeric
  // Chat user IDs and `all` still parse so older routes keep working.
  mention_targets: z.array(z.string()).default([]).transform((values, ctx) => {
    const normalized: string[] = [];
    for (const [index, value] of values.entries()) {
      const mention = normalizeGoogleChatMentionId(value);
      if (!mention) {
        ctx.addIssue({
          code: "custom", path: [index],
          message: "Tag harus berupa email kerja, user ID Google Chat, atau 'all'.",
        });
      } else if (!normalized.includes(mention)) {
        normalized.push(mention);
      }
    }
    return normalized;
  }),
  // Where inside the Space this route posts. Defaults to the previous
  // behaviour: one thread per alert, keyed by dedup_key.
  thread_mode: z.enum(["per_alert", "single", "existing"]).default("per_alert"),
  /** Fixed thread key for thread_mode = "single". */
  thread_key: z.string().trim().max(512).default(""),
  /**
   * `spaces/<space>/threads/<thread>` for thread_mode = "existing".
   *
   * Stored canonical. Admins paste the room link, and Google rejects a message
   * whose thread.name is a URL — which is why alerts failed to reach the thread
   * while Test send (which normalised separately) worked.
   */
  thread_name: z.string().trim().max(200).default("")
    .transform((value) => normalizeGoogleChatThreadName(value) ?? value),
  /**
   * Per-warehouse thread override, e.g. `{ "CBT": "spaces/…/threads/…" }`.
   * Lets one route fan a Space out into a thread per warehouse instead of
   * forcing the admin to repeat the same webhook URL once per site.
   */
  thread_names: z.record(
    z.string().trim().min(1).max(20),
    z.string().trim().max(200).transform((value) => normalizeGoogleChatThreadName(value) ?? value),
  ).default({}),
}).superRefine((route, ctx) => {
  if (route.thread_mode === "single" && !route.thread_key) {
    ctx.addIssue({
      code: "custom", path: ["thread_key"],
      message: "Mode satu thread membutuhkan kunci thread.",
    });
  }
  if (route.thread_mode !== "existing") return;
  const space = googleChatSpaceOf(route.webhook_url);

  // Posting into a thread of another Space fails silently at Google's end, so
  // catch the mismatch while the admin is still looking at the form.
  const checkThread = (raw: string, path: (string | number)[]) => {
    const name = normalizeGoogleChatThreadName(raw);
    if (!name) {
      ctx.addIssue({
        code: "custom", path,
        message: "Nama thread harus berformat spaces/<space>/threads/<thread>.",
      });
      return;
    }
    if (space && !name.startsWith(`spaces/${space}/`)) {
      ctx.addIssue({
        code: "custom", path,
        message: `Thread ini bukan milik Space webhook (spaces/${space}).`,
      });
    }
  };

  const perWarehouse = Object.entries(route.thread_names).filter(([, value]) => value.trim());
  for (const [warehouse, value] of perWarehouse) checkThread(value, ["thread_names", warehouse]);

  // A blanket thread is only required when some scoped warehouse lacks its own.
  const scoped = route.warehouse_codes.filter((code) => code !== "*");
  const covered = new Set(perWarehouse.map(([warehouse]) => warehouse));
  const everyScopedHasThread = scoped.length > 0 && scoped.every((code) => covered.has(code));
  if (!everyScopedHasThread) checkThread(route.thread_name, ["thread_name"]);
});

/** Routes saved before tagging moved to email still carry `mention_user_ids`. */
const GoogleChatRoute = z.preprocess((value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const route = value as Record<string, unknown>;
    if (route.mention_targets === undefined && route.mention_user_ids !== undefined) {
      return { ...route, mention_targets: route.mention_user_ids };
    }
  }
  return value;
}, GoogleChatRouteSchema);

const RecipientsSchema = z.object({
  levels: z.array(z.object({
    level: z.number().int().positive(), name: z.string().trim().min(1), delay_minutes: z.number().min(0),
    gchat_routes: z.array(GoogleChatRoute).default([]),
    // Kept only so existing installations can load and migrate their previous
    // global webhook list through the new settings UI without losing data.
    gchat_webhooks: z.array(z.string().url()).default([]),
    webhooks: z.array(z.string().url()).default([]),
    emails: z.array(z.string().email()).default([]),
  })).min(1),
  severity_start_level: z.record(z.string(), z.number().int().positive()),
}).superRefine((value, ctx) => {
  const levels = new Set<number>();
  for (const [i, level] of value.levels.entries()) {
    if (levels.has(level.level)) ctx.addIssue({ code: "custom", path: ["levels", i, "level"], message: "Nomor level harus unik." });
    levels.add(level.level);
    if (level.level === 1 && level.delay_minutes !== 0) {
      ctx.addIssue({ code: "custom", path: ["levels", i, "delay_minutes"], message: "Level 1 harus dimulai tanpa jeda." });
    }
    const routeIds = new Set<string>();
    for (const [routeIndex, route] of level.gchat_routes.entries()) {
      if (routeIds.has(route.id)) {
        ctx.addIssue({ code: "custom", path: ["levels", i, "gchat_routes", routeIndex, "id"], message: "ID rute Google Chat harus unik dalam satu level." });
      }
      routeIds.add(route.id);
    }
  }
  const ordered = [...levels].sort((a, b) => a - b);
  if (ordered.some((level, index) => level !== index + 1)) {
    ctx.addIssue({ code: "custom", path: ["levels"], message: "Level eskalasi harus berurutan mulai dari 1." });
  }
  for (const [severity, level] of Object.entries(value.severity_start_level)) {
    if (!levels.has(level)) ctx.addIssue({ code: "custom", path: ["severity_start_level", severity], message: "Level awal harus ada pada daftar eskalasi." });
  }
});

const WarehousesSchema = z.object({
  warehouses: z.array(z.object({
    code: z.string(), location_id: z.number(), name: z.string(),
    latitude: z.number().optional(), longitude: z.number().optional(),
  })).min(1),
}).superRefine((value, ctx) => {
  const codes = new Set<string>(); const ids = new Set<number>();
  value.warehouses.forEach((w, i) => {
    if (codes.has(w.code)) ctx.addIssue({ code: "custom", path: ["warehouses", i, "code"], message: "Kode warehouse harus unik." });
    if (ids.has(w.location_id)) ctx.addIssue({ code: "custom", path: ["warehouses", i, "location_id"], message: "location_id harus unik." });
    codes.add(w.code); ids.add(w.location_id);
  });
});

// ---- Kapasitas & basis okupansi (Qty/CBM) ----------------------------------
// Resolver precedence: defaults -> rules berurutan (aturan di bawah menimpa).
// Scope ber-kategori hanya boleh mengatur `count` (dihitung/tidak).
const CapacityRule = z.object({
  scope: z.object({
    wh: z.string().optional(),
    zone: z.string().optional(),        // cocok dgn zone (SRA) ATAU rack_zone (SRA1)
    rack_zone: z.string().optional(),   // blok/rack spesifik, mis. MZA1
    aisle: z.string().optional(),
    bay: z.string().optional(),
    level: z.string().optional(),
    bin: z.string().optional(),
    storage: z.string().optional(),
    l1_category: z.string().optional(),
  }).catchall(z.string()),
  set: z.object({
    basis: z.enum(["qty", "cbm"]).optional(),
    max_qty: z.number().positive().optional(),
    max_cbm: z.number().positive().optional(),
    utilization_pct: z.number().min(10).max(100).optional(),
    count: z.boolean().optional(),
  }),
  note: z.string().default(""),
});

const CapacitySchema = z.object({
  basis_default: z.enum(["qty", "cbm"]).default("qty"),
  utilization_pct: z.number().min(10).max(100).default(85),
  count_statuses: z.array(z.string()).min(1).default(["Available"]),
  exclude_categories: z.array(z.string()).default([]),
  /**
   * Zones that must not take part in any occupancy figure.
   *
   * A warehouse carries zones that exist in the master data but hold no real
   * storage — staging, virtual, or transit areas with no capacity. Counting
   * them adds locations to the denominator that can never be filled, which
   * quietly drags the warehouse percentage down and makes a full site look
   * comfortable. Listing a zone here removes it from both the numerator and the
   * denominator everywhere occupancy is computed, so the remaining percentage
   * describes only space that can actually be used.
   *
   * Only the `zone` column is matched, never `rack_zone`: this is a decision
   * about an area of the warehouse, and matching both would silently disable
   * rack blocks that happen to share a name.
   */
  disabled_zones: z.array(z.object({
    wh: z.string().trim().min(1).max(20),
    zone: z.string().trim().min(1).max(40),
    note: z.string().trim().max(200).default(""),
  })).default([]),
  /**
   * Baris kosong hasil "Tambah aturan" yang tidak jadi diisi dibuang di sini.
   *
   * Aturan tanpa scope DAN tanpa nilai tidak mengubah apa pun, tetapi ia ikut
   * terhitung pada penghitung aturan, memperpanjang tabel editor, dan membuat
   * pencarian "override global" (aturan pertama tanpa scope) mendarat di baris
   * kosong alih-alih di kebijakan yang sebenarnya. Membersihkannya saat parse
   * berarti konfigurasi lama ikut rapi tanpa migrasi terpisah.
   */
  rules: z.array(CapacityRule).default([]).transform((rules) =>
    rules.filter((rule) =>
      Object.keys(rule.scope).length > 0
      || Object.values(rule.set).some((value) => value !== undefined)
      || rule.note.trim().length > 0)),
}).superRefine((v, ctx) => {
  const seen = new Set<string>();
  v.disabled_zones.forEach((entry, i) => {
    const key = `${entry.wh}|${entry.zone}`;
    if (seen.has(key)) {
      ctx.addIssue({
        code: "custom", path: ["disabled_zones", i],
        message: `Zona ${entry.zone} pada ${entry.wh} tercatat lebih dari sekali.`,
      });
    }
    seen.add(key);
  });
  v.rules.forEach((r, i) => {
    const hasCat = !!r.scope.l1_category;
    const capKeys = [r.set.basis, r.set.max_qty, r.set.max_cbm, r.set.utilization_pct]
      .some((x) => x !== undefined);
    if (hasCat && capKeys) {
      ctx.addIssue({ code: "custom", path: ["rules", i],
        message: "Scope ber-kategori hanya boleh mengatur 'count' (bukan basis/max/utilisasi)." });
    }
    if (r.set.count !== undefined && !hasCat) {
      ctx.addIssue({ code: "custom", path: ["rules", i],
        message: "'count' hanya berlaku untuk scope ber-kategori." });
    }
  });
});

export type ThresholdConfig = z.infer<typeof ThresholdSchema>;
export type RulesConfig = z.infer<typeof RulesSchema>;
export type RecipientsConfig = z.infer<typeof RecipientsSchema>;
export type GoogleChatRouteConfig = z.infer<typeof GoogleChatRouteSchema>;
export type WarehousesConfig = z.infer<typeof WarehousesSchema>;
export type CapacityConfig = z.infer<typeof CapacitySchema>;
export type CapacityRuleT = z.infer<typeof CapacityRule>;

const schemas = {
  thresholds: ThresholdSchema,
  rules: RulesSchema,
  recipients: RecipientsSchema,
  warehouses: WarehousesSchema,
  capacity: CapacitySchema,
} as const;
export type ConfigSection = keyof typeof schemas;

const cache = new Map<string, { file: string; mtime: number; data: unknown }>();

function readSection<T>(section: ConfigSection): T {
  const file = sectionFile(section);
  const stat = fs.statSync(file);
  const hit = cache.get(section);
  // Berkas ikut dibandingkan: begitu penyimpanan pertama memindahkan seksi ini
  // dari seed image ke volume permanen, sumbernya berganti dan cache lama tidak
  // boleh dipakai hanya karena mtime-nya kebetulan sama.
  if (hit && hit.file === file && hit.mtime === stat.mtimeMs) return hit.data as T;
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  const parsed = schemas[section].parse(raw);
  cache.set(section, { file, mtime: stat.mtimeMs, data: parsed });
  return parsed as T;
}

/**
 * Zones switched off for occupancy, keyed `WH|ZONE`.
 *
 * Shared by the SQL predicate in lib/queries.ts and the Node-side checks so a
 * zone can never be excluded from one and counted by the other.
 */
export function disabledZoneKeys(): Set<string> {
  return new Set(getCapacity().disabled_zones.map((entry) => `${entry.wh}|${entry.zone}`));
}

export function isZoneDisabled(warehouseCode: string, zone: string | null | undefined): boolean {
  if (!zone) return false;
  return disabledZoneKeys().has(`${warehouseCode}|${zone}`);
}

export const getThresholds = () => readSection<ThresholdConfig>("thresholds");
export const getRules = () => readSection<RulesConfig>("rules");
export const getRecipients = () => readSection<RecipientsConfig>("recipients");
export const getWarehouses = () => readSection<WarehousesConfig>("warehouses");
export const getCapacity = () => readSection<CapacityConfig>("capacity");

export function writeSection(section: ConfigSection, data: unknown): unknown {
  const parsed = schemas[section].parse(data);
  if (section === "recipients") {
    const knownWarehouses = new Set(getWarehouses().warehouses.map((warehouse) => warehouse.code));
    const recipients = parsed as RecipientsConfig;
    for (const level of recipients.levels) {
      for (const route of level.gchat_routes) {
        const unknown = route.warehouse_codes.filter((code) => code !== "*" && !knownWarehouses.has(code));
        if (unknown.length) throw new Error(`Warehouse pada rute Google Chat tidak dikenal: ${unknown.join(", ")}.`);
      }
    }
  }
  if (section === "capacity") {
    // A typo in a warehouse code would silently disable nothing, leaving the
    // admin convinced a zone was excluded while it still counts.
    const knownWarehouses = new Set(getWarehouses().warehouses.map((warehouse) => warehouse.code));
    const unknown = (parsed as CapacityConfig).disabled_zones
      .filter((entry) => !knownWarehouses.has(entry.wh))
      .map((entry) => `${entry.wh}/${entry.zone}`);
    if (unknown.length) throw new Error(`Warehouse pada zona nonaktif tidak dikenal: ${unknown.join(", ")}.`);
  }
  // Penulisan atomik: berkas kebijakan yang terpotong karena proses mati di
  // tengah tulis akan membuat aplikasi gagal start pada restart berikutnya.
  // 0o644: worker sinkronisasi Python membaca folder yang sama dan pada
  // sebagian deployment berjalan sebagai pengguna berbeda dari aplikasi web.
  // Berkas rahasia tidak lewat jalur ini — ia ditulis dengan 0o600 tersendiri.
  writeConfigJsonAtomic(sectionFile(section, true), parsed, 0o644);
  cache.delete(section);
  return parsed;
}

export function thresholdsFor(warehouseCode: string) {
  const cfg = getThresholds();
  const o = cfg.overrides[warehouseCode] || {};
  return {
    monitor: o.monitor ?? cfg.default.monitor,
    warning: o.warning ?? cfg.default.warning,
    critical: o.critical ?? cfg.default.critical,
    breach: o.breach ?? cfg.default.breach,
    hysteresis_buffer: o.hysteresis_buffer ?? cfg.default.hysteresis_buffer,
  };
}

export function whByLocationId(): Map<number, { code: string; name: string }> {
  const m = new Map<number, { code: string; name: string }>();
  for (const w of getWarehouses().warehouses) m.set(w.location_id, { code: w.code, name: w.name });
  return m;
}


/** VALUES SQL peta location_id → kode WH (sekaligus ALLOWLIST lokasi). */
export function whMapSQL(): string {
  const rows = getWarehouses().warehouses
    .map((w) => `(${Number(w.location_id)}, '${w.code.replace(/'/g, "''")}')`)
    .join(", ");
  return `wh_map(location_id, wh) AS (VALUES ${rows})`;
}

/** Daftar location_id yang diizinkan tampil (gudang, bukan hub). */
export function allowedLocationIds(): number[] {
  return getWarehouses().warehouses.map((w) => Number(w.location_id));
}

export function whNameByCode(): Map<string, string> {
  return new Map(getWarehouses().warehouses.map((w) => [w.code, w.name]));
}
