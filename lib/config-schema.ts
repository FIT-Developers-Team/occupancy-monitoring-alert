// Bentuk setiap berkas kebijakan, terpisah dari cara membacanya.
//
// KENAPA MODUL SENDIRI
// --------------------
// Skema ini dulu tinggal di lib/config.ts. Selama ia berada di sana, satu-satunya
// yang dapat memvalidasi isi berkas konfigurasi adalah modul yang juga membaca
// dan menulisnya — dan lib/runtime-config.ts, yang memulihkan cadangan serta
// menyalin `WIOM_CONFIG_BUNDLE` ke volume, tidak boleh mengimpornya karena
// lib/config.ts sudah mengimpor runtime-config (siklus impor).
//
// Akibatnya nyata dan pernah terjadi: pemulihan cadangan menulis apa pun yang
// ada di berkas ke `db/runtime-config/*.json` tanpa pernah memeriksanya. Satu
// berkas yang bentuknya tidak lagi cocok — cadangan versi lama, berkas yang
// disunting tangan, unduhan yang terpotong — membuat setiap pembacaan
// konfigurasi berikutnya melempar, dan itu berarti SELURUH halaman gagal
// dirender. Aplikasi tampak rusak total setelah "memulihkan cadangan", tanpa
// satu pun jalan kembali dari dalam antarmuka.
//
// Memisahkan skema ke modul tanpa dependensi apa pun selain zod menutup itu:
// runtime-config dapat memvalidasi setiap berkas SEBELUM satu byte ditulis,
// dan lib/config.ts tetap memakai skema yang sama persis untuk membaca.
import { z } from "zod";
import {
  googleChatSpaceOf,
  isGoogleChatWebhookUrl,
  normalizeGoogleChatMentionId,
  normalizeGoogleChatThreadName,
} from "@/lib/notify/gchat-url";

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
    /**
     * Seberapa jauh ke belakang pergerakan diperiksa bila jam evaluasi terakhir
     * tidak diketahui — misalnya pada tick pertama sesudah deploy. Pada operasi
     * normal jendelanya mengikuti jarak ke evaluasi sebelumnya, bukan angka ini.
     */
    window_hours: z.number().min(0.25).max(24).default(1),
    max_alerts: z.number().int().min(1).max(200).default(20),
    /**
     * Tidak lagi dipakai. Dipertahankan supaya konfigurasi lama tetap terbaca
     * tanpa membuat aplikasi gagal start: pemicunya kini adalah pergerakan yang
     * membuat sebuah lokasi melewati kapasitas, bukan ambang volume notifikasi.
     */
    min_pct: z.number().min(100).max(1000).default(110),
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
   * Dua sumbu dinilai bersama, sehingga tingkatannya membentuk tangga:
   *
   *   |            | tepat di kapasitas | melebihi kapasitas |
   *   | satu basis | HIGH               | CRITICAL           |
   *   | dua basis  | CRITICAL           | EMERGENCY          |
   *
   * Severity kondisi lain dapat diatur karena batas antara "perlu dirapikan"
   * dan "hentikan inbound" adalah keputusan operasional yang berbeda di setiap
   * gudang. Hanya kontrak dua basis tepat di max = Critical yang dikunci.
   */
  overflow_severity: z.object({
    /**
     * Batas fisik kapasitas selalu 100% dari max_qty/max_cbm efektif.
     *
     * Versi lama membolehkan admin menggeser angka ini sampai 1.000%. Itu
     * membuat lokasi yang Qty dan CBM-nya sudah persis sama dengan nilai max
     * tidak lagi Critical, sehingga arti "max" berubah menurut konfigurasi
     * alert. Nilai lama tetap diterima agar deployment tidak gagal start, lalu
     * dinormalisasi ke 100 pada pembacaan/penyimpanan berikutnya.
     */
    over_pct: z.number().min(100).max(1000).default(100).transform(() => 100 as const),
    /** Qty ATAU CBM melebihi kapasitas, sementara keduanya terukur. */
    single_basis: SeverityEnum.default("CRITICAL"),
    /** Qty DAN CBM sama-sama melebihi kapasitas. */
    dual_basis: SeverityEnum.default("EMERGENCY"),
    /**
     * Qty DAN CBM sama-sama TEPAT di kapasitas maksimum, tidak melebihinya.
     *
     * Kondisi ini terpisah dari "sama-sama melebihi" karena tindakannya
     * berbeda: isinya persis sama dengan angka maksimum yang disetel, jadi
     * lokasinya memang penuh dan harus berhenti menerima inbound, tetapi belum
     * ada satu unit pun yang tidak punya tempat dan angka masternya masih
     * konsisten dengan kenyataan. Bawaan Critical — satu tingkat di bawah
     * Breach yang dipakai saat kapasitas benar-benar terlampaui.
     */
    // Invariant bisnis: dua basis tepat di max selalu Critical. Nilai lama
    // tetap diterima untuk migrasi, tetapi tidak boleh mengubah kategorinya.
    dual_at_capacity: SeverityEnum.default("CRITICAL").transform(() => "CRITICAL" as const),
    /**
     * Satu basis tepat di kapasitas maksimum sementara basis lainnya masih
     * longgar. Bawaannya sengaja di bawah "tepat di kapasitas pada keduanya":
     * satu pengukuran yang pas di angka maksimum belum membuktikan lokasinya
     * penuh.
     */
    single_at_capacity: SeverityEnum.default("HIGH"),
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

/** Dimensi scope yang benar-benar dibaca resolver (lib/capacity.ts). */
export const CAPACITY_SCOPE_KEYS = [
  "wh", "zone", "rack_zone", "aisle", "bay", "level", "bin", "storage", "l1_category",
] as const;
export type CapacityScopeKey = (typeof CAPACITY_SCOPE_KEYS)[number];

const CapacityScope = z.object({
  wh: z.string().optional(),
  zone: z.string().optional(),        // cocok dgn zone (SRA) ATAU rack_zone (SRA1)
  rack_zone: z.string().optional(),   // blok/rack spesifik, mis. MZA1
  aisle: z.string().optional(),
  bay: z.string().optional(),
  level: z.string().optional(),
  bin: z.string().optional(),
  storage: z.string().optional(),
  l1_category: z.string().optional(),
})
  // Kunci yang tidak dikenal dibuang, bukan ditolak.
  //
  // Sebelumnya `catchall(z.string())` menerimanya lalu resolver mengabaikannya:
  // satu salah ketik ("zona" alih-alih "zone") menghasilkan aturan yang
  // tersimpan, tampil di editor, dan tidak pernah cocok dengan apa pun. Menolak
  // berkasnya justru membuat instalasi lama gagal start, jadi kuncinya dibuang
  // di sini dan editor menampilkan berapa lokasi yang benar-benar cocok.
  .catchall(z.unknown())
  .transform((scope) => {
    const cleaned: Record<string, string> = {};
    for (const key of CAPACITY_SCOPE_KEYS) {
      const value = scope[key];
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed) cleaned[key] = trimmed;
    }
    return cleaned as Partial<Record<CapacityScopeKey, string>>;
  });

const CapacityRule = z.object({
  scope: CapacityScope,
  set: z.object({
    basis: z.enum(["qty", "cbm"]).optional(),
    max_qty: z.number().positive("Maks. Qty harus lebih besar dari 0.").optional(),
    max_cbm: z.number().positive("Maks. CBM harus lebih besar dari 0.").optional(),
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


// ---- Standar CBM per SKU ----------------------------------------------------
//
// KENAPA SEBUAH ANGKA DARI SUMBER DATA PERLU DAPAT DITIMPA
// -------------------------------------------------------
// `occupied_cbm` pada dataset stok adalah hasil `stock_qty × sku_cbm` — telah
// diverifikasi terhadap basis data ini: 90.573 baris, nol yang menyimpang. Jadi
// SELURUH sisi pembilang okupansi CBM di aplikasi ini berdiri di atas satu
// angka per SKU: volume satu unitnya.
//
// Angka itu datang dari master produk, dan di sanalah masalahnya. Volume master
// diisi sekali saat produk dibuat, sering dari dimensi kartonnya, kadang nol,
// kadang dalam satuan yang keliru. Ketika sebuah SKU salah volumenya, yang
// terlihat bukan "data master salah" melainkan sebuah gudang yang tampak 140%
// penuh atau 12% kosong — dan tidak ada satu pun layar yang dapat memperbaiki
// itu, karena memperbaikinya menuntut mengubah master di sistem lain dan
// menunggu sinkronisasi berikutnya.
//
// Blok ini memberi admin angka penggantinya. Nilai di sini MENIMPA `sku_cbm`
// dari sumber data, dan karena `occupied_cbm` dihitung ulang dari qty × standar
// baru, seluruh tampilan — heatmap, okupansi, penjelajah SLOC, alert, ekspor,
// proyeksi — langsung memakai angka yang sama. Tidak ada satu jalur baca pun
// yang boleh melewatinya; lihat `stockLatestSQL()` di lib/queries.ts.

/**
 * Batas atas jumlah standar.
 *
 * Setiap standar menambah satu cabang CASE pada pembungkus tabel stok, dan
 * pembungkus itu dipakai setiap kueri okupansi. Terukur pada basis data ini
 * (145 ribu lokasi, 90 ribu baris stok), pada agregat okupansi per gudang:
 *
 *   0 standar   →  175 ms  ·  2 KB SQL
 *   100         →  237 ms  · 13 KB
 *   500         →  499 ms  · 54 KB
 *
 * Angka itu tetap di bawah cache read model (lima menit), dan pemakaian nyata —
 * segelintir sampai beberapa puluh SKU yang volume masternya keliru — praktis
 * gratis. Batasnya dipasang agar sebuah tempelan yang tidak disengaja tidak
 * dapat mengubah jalur panas menjadi berdetik-detik.
 */
export const MAX_SKU_STANDARDS = 2000;

const SkuStandardsSchema = z.object({
  standards: z.array(z.object({
    /**
     * Nomor SKU persis seperti pada dataset stok, dinormalisasi huruf besar.
     *
     * Pencocokan memakai `upper(trim(...))` di kedua sisi supaya sebuah SKU
     * yang tersimpan dengan spasi ekor pada master tidak diam-diam luput.
     */
    sku: z.string().trim().min(1).max(64).transform((value) => value.toUpperCase()),
    /** Volume satu unit dalam m³ — menggantikan `sku_cbm` dari sumber data. */
    unit_cbm: z.number().positive("Standar CBM harus lebih besar dari 0.").max(1000),
    /** Untuk apa nilainya diubah — dibaca orang lain enam bulan kemudian. */
    note: z.string().trim().max(200).default(""),
    /** Jejak audit ringan; diisi server saat menyimpan. */
    updated_at: z.string().trim().max(40).default(""),
    updated_by: z.string().trim().max(80).default(""),
  })).max(MAX_SKU_STANDARDS).default([]),
}).superRefine((value, ctx) => {
  // Dua baris untuk SKU yang sama berarti angka mana yang berlaku ditentukan
  // urutan baris — dan itu tidak dapat dilihat dari layar mana pun.
  const seen = new Map<string, number>();
  value.standards.forEach((entry, index) => {
    const first = seen.get(entry.sku);
    if (first !== undefined) {
      ctx.addIssue({
        code: "custom", path: ["standards", index, "sku"],
        message: `SKU ${entry.sku} sudah diatur pada baris ${first + 1}.`,
      });
    }
    seen.set(entry.sku, index);
  });
});

export type SkuStandardsConfig = z.infer<typeof SkuStandardsSchema>;
export type SkuStandard = SkuStandardsConfig["standards"][number];

export type ThresholdConfig = z.infer<typeof ThresholdSchema>;
/** Kebijakan penerjemah kondisi kapasitas → severity (lib/alerts/severity.ts). */
export type OverflowSeverityConfig = ThresholdConfig["overflow_severity"];
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
  "sku-standards": SkuStandardsSchema,
} as const;
export type ConfigSection = keyof typeof schemas;
export const CONFIG_SCHEMAS = schemas;

// ---- Validasi berkas cadangan ----------------------------------------------
//
// Pemulihan cadangan menulis berkas, bukan seksi. Daftar di bawah memetakan
// nama berkas ke pemeriksa isinya sehingga lib/runtime-config.ts dapat menolak
// cadangan yang rusak SEBELUM menulisnya — lihat catatan di kepala berkas ini
// untuk apa yang terjadi ketika ia tidak melakukannya.

/**
 * Penyimpanan akun.
 *
 * Skema penuhnya (hash scrypt, riwayat persetujuan) tinggal di
 * lib/account-store.ts dan tidak dapat diimpor dari sini tanpa siklus. Yang
 * diperiksa adalah bentuk yang membuat readStore() melempar, plus satu
 * invarian yang tidak boleh dilanggar sebuah pemulihan: harus tersisa
 * setidaknya satu admin aktif, kalau tidak berkas cadangan yang sah pun akan
 * mengunci seluruh administrator keluar dari aplikasinya sendiri.
 */
const AccountsFileSchema = z.object({
  version: z.literal(1, { message: "Versi penyimpanan akun harus 1." }),
  settings: z.object({}).passthrough(),
  accounts: z.array(z.object({
    username: z.string().min(1),
    role: z.string().min(1),
    status: z.string().min(1),
  }).passthrough()),
}).passthrough().superRefine((value, ctx) => {
  const admins = value.accounts.filter(
    (account) => account.role === "admin" && account.status === "active",
  );
  if (admins.length === 0) {
    ctx.addIssue({
      code: "custom", path: ["accounts"],
      message: "Cadangan akun tidak memuat satu pun admin aktif — memulihkannya akan mengunci semua admin keluar.",
    });
  }
});

/**
 * Konfigurasi & kredensial Superset.
 *
 * Sengaja longgar: lib/superset-sync.ts sudah membacanya dengan safeParse dan
 * jatuh ke bawaan saat isinya tidak cocok, jadi berkas ini tidak dapat
 * mematikan antarmuka. Yang perlu dicegah hanyalah nilai yang jelas bukan
 * konfigurasi sama sekali.
 */
const LooseObjectSchema = z.object({}).passthrough();

const fileSchemas: Record<string, z.ZodTypeAny> = {
  "thresholds.json": ThresholdSchema,
  "rules.json": RulesSchema,
  "recipients.json": RecipientsSchema,
  "warehouses.json": WarehousesSchema,
  "capacity.json": CapacitySchema,
  "sku-standards.json": SkuStandardsSchema,
  "accounts.json": AccountsFileSchema,
  "superset-sync.json": LooseObjectSchema,
  ".superset-sync.secrets.json": LooseObjectSchema,
};

/** Ringkas satu ZodError menjadi kalimat yang berguna di layar admin. */
export function describeConfigIssues(error: z.ZodError, limit = 3): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const issue of error.issues) {
    const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
    const line = `${where}${issue.message}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length >= limit) break;
  }
  const extra = error.issues.length - lines.length;
  return lines.join("; ") + (extra > 0 ? ` (+${extra} lainnya)` : "");
}

export interface ConfigFileCheck {
  /** Nilai yang sudah dinormalisasi skema — inilah yang layak ditulis. */
  value: unknown;
}

/**
 * Periksa satu berkas konfigurasi terhadap skemanya.
 *
 * Mengembalikan nilai hasil parse, bukan masukan mentah: bidang yang hilang
 * terisi bawaannya dan kunci scope yang tidak dikenal ikut dibuang, sehingga
 * berkas yang ditulis ke volume adalah bentuk yang benar-benar dapat dibaca
 * ulang aplikasi. Melempar `Error` berisi ringkasan masalahnya bila tidak.
 */
export function checkConfigFile(basename: string, value: unknown): unknown {
  const schema = fileSchemas[basename];
  if (!schema) return value;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(describeConfigIssues(parsed.error));
}

/**
 * Invarian yang menghubungkan beberapa berkas sekaligus.
 *
 * Setiap berkas dapat sah sendirian dan tetap saling bertabrakan: zona nonaktif
 * yang menyebut gudang yang tidak ada pada warehouses.json tidak menonaktifkan
 * apa pun, dan rute Google Chat yang menyebut kode gudang asing tidak pernah
 * terkirim. Keduanya gagal DIAM-DIAM — persis kelas kesalahan yang membuat
 * admin yakin sudah menyetel sesuatu padahal belum.
 *
 * Dipanggil pada dua tempat yang keduanya menulis konfigurasi: penyimpanan satu
 * seksi lewat halaman Pengaturan, dan pemulihan cadangan yang menulis banyak
 * berkas sekaligus. `files` harus berisi bentuk GABUNGAN sesudah penulisan —
 * nilai baru bila ada, nilai yang berlaku sekarang bila tidak — supaya
 * cadangan sebagian tetap diperiksa terhadap sisa konfigurasi yang bertahan.
 */
export function checkConfigCoherence(files: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const warehouses = files["warehouses.json"] as WarehousesConfig | undefined;
  if (!warehouses?.warehouses) return problems;
  const known = new Set(warehouses.warehouses.map((warehouse) => warehouse.code));

  const capacity = files["capacity.json"] as CapacityConfig | undefined;
  const unknownZones = (capacity?.disabled_zones ?? [])
    .filter((entry) => !known.has(entry.wh))
    .map((entry) => `${entry.wh}/${entry.zone}`);
  if (unknownZones.length) {
    problems.push(`Warehouse pada zona nonaktif tidak dikenal: ${unknownZones.join(", ")}.`);
  }

  // Kode gudang asing pada scope aturan sengaja TIDAK ditolak di sini. Aturan
  // yang tidak cocok dengan apa pun bersifat aditif — ia tidak merusak angka
  // mana pun, hanya tidak berlaku — dan menolak penyimpanan karenanya berarti
  // satu gudang tidak dapat dihapus selama masih ada aturan lama yang
  // menyebutnya. Editor kapasitas menampilkan "cocok dengan 0 lokasi" pada
  // baris tersebut, yang lebih tepat sasaran daripada pesan galat global.

  const recipients = files["recipients.json"] as RecipientsConfig | undefined;
  const unknownRoutes = [...new Set((recipients?.levels ?? []).flatMap((level) =>
    level.gchat_routes.flatMap((route) =>
      route.warehouse_codes.filter((code) => code !== "*" && !known.has(code)))))];
  if (unknownRoutes.length) {
    problems.push(`Warehouse pada rute Google Chat tidak dikenal: ${unknownRoutes.join(", ")}.`);
  }
  return problems;
}
