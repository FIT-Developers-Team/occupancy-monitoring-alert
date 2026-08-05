// Config-driven policy layer: thresholds, rules, recipients, warehouses, capacity.
import fs from "fs";
import path from "path";
import { z } from "zod";
import {
  googleChatSpaceOf,
  isGoogleChatWebhookUrl,
  normalizeGoogleChatMentionId,
  normalizeGoogleChatThreadName,
} from "@/lib/notify/gchat-url";

const CONFIG_DIR = path.join(process.cwd(), "config");
const RUNTIME_CONFIG_DIR = process.env.WIOM_RUNTIME_CONFIG_DIR?.trim()
  ? path.resolve(process.env.WIOM_RUNTIME_CONFIG_DIR.trim())
  : path.join(process.cwd(), "db", "runtime-config");

function sectionFile(section: ConfigSection, forWrite = false): string {
  if (section !== "recipients") return path.join(CONFIG_DIR, `${section}.json`);
  const runtimeFile = path.join(RUNTIME_CONFIG_DIR, "recipients.json");
  if (forWrite || fs.existsSync(runtimeFile)) return runtimeFile;
  return path.join(CONFIG_DIR, "recipients.json");
}

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
    severity: z.enum(["INFO", "WARNING", "HIGH", "CRITICAL", "EMERGENCY"]),
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
  /** `spaces/<space>/threads/<thread>` for thread_mode = "existing". */
  thread_name: z.string().trim().max(200).default(""),
  /**
   * Per-warehouse thread override, e.g. `{ "CBT": "spaces/…/threads/…" }`.
   * Lets one route fan a Space out into a thread per warehouse instead of
   * forcing the admin to repeat the same webhook URL once per site.
   */
  thread_names: z.record(z.string().trim().min(1).max(20), z.string().trim().max(200)).default({}),
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
  rules: z.array(CapacityRule).default([]),
}).superRefine((v, ctx) => {
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

const cache = new Map<string, { mtime: number; data: unknown }>();

function readSection<T>(section: ConfigSection): T {
  const file = sectionFile(section);
  const stat = fs.statSync(file);
  const hit = cache.get(section);
  if (hit && hit.mtime === stat.mtimeMs) return hit.data as T;
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  const parsed = schemas[section].parse(raw);
  cache.set(section, { mtime: stat.mtimeMs, data: parsed });
  return parsed as T;
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
  const file = sectionFile(section, true);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
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
