// Kontrak bersama untuk "Recent movements" — dipakai halaman server, komponen
// klien, endpoint JSON, dan ekspor Excel.
//
// MENGAPA DI SINI, BUKAN DI lib/queries
// -------------------------------------
// Tabel movement adalah komponen klien; mengimpor apa pun dari read-model akan
// menarik DuckDB ke dalam bundel browser. Modul ini murni (tanpa I/O, tanpa
// dependensi server) persis seperti lib/sloc-filter.ts, sehingga taksonomi aksi
// yang sama dipakai oleh SQL di server DAN oleh label di layar — tidak mungkin
// menyimpang satu sama lain.
//
// STANDARDISASI `inventory_action`
// --------------------------------
// Dataset sumber (Superset 705) menyimpan aksi apa adanya seperti yang diketik
// WMS: satu gudang menulis "Putaway", yang lain "PUT_AWAY", "Penempatan", atau
// "Putaway from Staging". Menampilkannya mentah membuat filter tidak berguna —
// puluhan nilai untuk enam kegiatan yang sama. Karena itu setiap aksi dipetakan
// ke SATU tipe kanonik di bawah, sementara teks aslinya tetap disimpan dan
// ditampilkan pada panel detail supaya tidak ada informasi yang hilang.

/** Tipe pergerakan kanonik — urutannya juga urutan tampil pada filter. */
export const MOVEMENT_TYPES = [
  "RECEIVING",
  "PUTAWAY",
  "PICKING",
  "PACKING",
  "DISPATCH",
  "TRANSFER",
  "RETURN",
  "ADJUSTMENT",
  "STATUS_CHANGE",
  "OTHER",
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/**
 * Aturan pemetaan aksi mentah → tipe kanonik, dievaluasi BERURUTAN (yang cocok
 * pertama menang). Urutannya disengaja: "Stock Opname Transfer" adalah kegiatan
 * penyesuaian, bukan pemindahan, sehingga ADJUSTMENT harus diuji lebih dulu.
 *
 * Teks aksi DINORMALKAN lebih dulu: setiap rangkaian karakter bukan
 * huruf/angka menjadi satu spasi. Tanpa itu "PUT_AWAY" — ejaan yang benar-benar
 * dipakai WMS — tidak cocok dengan kata kunci mana pun dan jatuh ke "Lainnya",
 * sementara "Putaway" pada baris di sebelahnya tergolong dengan benar. Setelah
 * normalisasi keduanya sampai pada tipe yang sama.
 *
 * Setelah itu setiap kata kunci dicocokkan sebagai AWALAN KATA (`\b`), bukan
 * sekadar substring. Perbedaannya nyata: substring "move" ikut cocok pada
 * "remove" (pengurangan stok, bukan pemindahan), sedangkan `\bmove` tidak —
 * dan normalisasi di atas tidak merusak sifat itu karena pemisah menjadi spasi,
 * bukan dihapus.
 */
const RULES: Array<{ type: MovementType; keywords: string[] }> = [
  {
    type: "ADJUSTMENT",
    keywords: [
      "opname", "stock take", "stocktake", "cycle count", "counting", "recount",
      "adjust", "penyesuaian", "koreksi", "correct", "variance", "selisih",
    ],
  },
  {
    type: "RETURN",
    keywords: ["return", "retur", "rto", "refund", "pengembalian", "reverse", "cancel"],
  },
  {
    type: "RECEIVING",
    keywords: [
      "receiv", "receipt", "inbound", "grn", "goods in", "penerimaan", "terima",
      "unload", "arrival", "check in", "checkin", "gate in",
    ],
  },
  {
    type: "PUTAWAY",
    keywords: ["putaway", "put away", "penempatan", "storing", "stow", "binning"],
  },
  {
    type: "PICKING",
    keywords: ["pick", "pengambilan", "ambil", "allocat", "reserv"],
  },
  {
    type: "PACKING",
    keywords: ["pack", "pengepakan", "consolidat", "sorting", "sortir", "labell", "labeling"],
  },
  {
    type: "DISPATCH",
    keywords: [
      "dispatch", "outbound", "ship", "delivery", "deliver", "loading", "handover",
      "pengiriman", "kirim", "goods out", "gate out", "issue", "sales",
    ],
  },
  {
    type: "TRANSFER",
    keywords: [
      "transfer", "move", "relocat", "pemindahan", "pindah", "shift", "mutasi",
      "internal", "bin to bin", "rack to rack", "replenish",
    ],
  },
  {
    type: "STATUS_CHANGE",
    keywords: [
      "status", "quarantine", "karantina", "damage", "rusak", "bad stock", "expire",
      "kadaluarsa", "kedaluwarsa", "disposal", "scrap", "block", "hold", "quality",
      "lost", "hilang", "found",
    ],
  },
];

/** Regex per aturan — dibangun sekali, dipakai ulang di server maupun klien. */
const RULE_MATCHERS = RULES.map((rule) => ({
  type: rule.type,
  test: new RegExp(`\\b(${rule.keywords.map(escapeRegex).join("|")})`, "i"),
}));

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Setiap pemisah (`_`, `-`, `/`, `.`, spasi ganda) menjadi satu spasi. */
const SEPARATORS = /[^a-z0-9]+/g;
export function normalizeActionText(raw: string | null | undefined): string {
  return String(raw ?? "").toLowerCase().replace(SEPARATORS, " ").trim();
}

/** Padanan SQL DuckDB dari normalizeActionText. */
function normalizeActionSQL(column: string): string {
  return `trim(regexp_replace(lower(coalesce(${column}, '')), '[^a-z0-9]+', ' ', 'g'))`;
}

/** Tipe kanonik untuk satu nilai `inventory_action` mentah. */
export function movementTypeOf(raw: string | null | undefined): MovementType {
  const text = normalizeActionText(raw);
  if (!text) return "OTHER";
  const found = RULE_MATCHERS.find((rule) => rule.test.test(text));
  return found ? found.type : "OTHER";
}

/**
 * Ekspresi SQL DuckDB yang menghasilkan tipe kanonik dari kolom aksi mentah.
 *
 * Dibangkitkan dari tabel aturan yang sama dengan `movementTypeOf`, jadi
 * penyaringan di server dan label di layar tidak mungkin memakai taksonomi yang
 * berbeda. Kata kuncinya konstanta di berkas ini — tidak ada masukan pengguna
 * yang masuk ke SQL dari sini.
 */
export function movementTypeSQL(column: string): string {
  const normalized = normalizeActionSQL(column);
  const branches = RULES.map((rule) => {
    const pattern = rule.keywords.map((keyword) => escapeRegex(keyword)).join("|");
    return `WHEN regexp_matches(${normalized}, '\\b(${pattern})') THEN '${rule.type}'`;
  });
  return `CASE ${branches.join(" ")} ELSE 'OTHER' END`;
}

// ---- arah pergerakan (inventory_operator) ----------------------------------

/** Penambahan atau pengurangan stok pada lokasi asal. */
export const MOVEMENT_DIRECTIONS = ["IN", "OUT", "NEUTRAL"] as const;
export type MovementDirection = (typeof MOVEMENT_DIRECTIONS)[number];

const OUT_TOKENS = ["-", "minus", "min", "out", "kurang", "pengurangan", "subtract", "decrease", "debit"];
const IN_TOKENS = ["+", "plus", "in", "tambah", "penambahan", "add", "increase", "credit"];

/**
 * Arah dari `inventory_operator`.
 *
 * Dicocokkan sebagai token utuh, bukan substring: "minus" mengandung "in", dan
 * pencocokan longgar akan membalik tanda seluruh baris pengurangan stok.
 */
export function movementDirectionOf(raw: string | null | undefined): MovementDirection {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text) return "NEUTRAL";
  if (text.startsWith("-") || OUT_TOKENS.includes(text)) return "OUT";
  if (text.startsWith("+") || IN_TOKENS.includes(text)) return "IN";
  return "NEUTRAL";
}

const sqlList = (values: string[]) => values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");

export function movementDirectionSQL(column: string): string {
  const normalized = `lower(trim(coalesce(${column}, '')))`;
  return `CASE
    WHEN ${normalized} = '' THEN 'NEUTRAL'
    WHEN starts_with(${normalized}, '-') OR ${normalized} IN (${sqlList(OUT_TOKENS)}) THEN 'OUT'
    WHEN starts_with(${normalized}, '+') OR ${normalized} IN (${sqlList(IN_TOKENS)}) THEN 'IN'
    ELSE 'NEUTRAL' END`;
}

// ---- alur lokasi -----------------------------------------------------------

/** Bentuk perpindahan lokasi: masuk gudang, keluar gudang, atau antar-lokasi. */
export const MOVEMENT_FLOWS = ["INBOUND", "INTERNAL", "OUTBOUND", "IN_PLACE"] as const;
export type MovementFlow = (typeof MOVEMENT_FLOWS)[number];

export function movementFlowSQL(from: string, to: string): string {
  const f = `nullif(trim(coalesce(${from}, '')), '')`;
  const t = `nullif(trim(coalesce(${to}, '')), '')`;
  return `CASE
    WHEN ${f} IS NULL AND ${t} IS NOT NULL THEN 'INBOUND'
    WHEN ${f} IS NOT NULL AND ${t} IS NULL THEN 'OUTBOUND'
    WHEN ${f} IS NOT NULL AND ${t} IS NOT NULL AND ${f} <> ${t} THEN 'INTERNAL'
    ELSE 'IN_PLACE' END`;
}

// ---- kontrak filter --------------------------------------------------------

export const MOVEMENT_RANGES = ["24h", "72h", "7d", "30d", "all"] as const;
export type MovementRange = (typeof MOVEMENT_RANGES)[number];

export const MOVEMENT_SORTS = ["at", "qty", "product", "type", "wh", "operator", "invoice"] as const;
export type MovementSort = (typeof MOVEMENT_SORTS)[number];

export interface MovementFilter {
  wh: string;
  /** Tipe kanonik; kosong = semua. */
  type: MovementType[];
  direction: MovementDirection | "";
  flow: MovementFlow | "";
  category: string;
  productType: string;
  /** Status tujuan (`to_status_notes`) — Available/Bad/Lost dan turunannya. */
  status: string;
  /** Kode SLOC; cocok pada rak asal MAUPUN rak tujuan. */
  sloc: string;
  operator: string;
  /** Pencarian bebas: produk, SKU, invoice/task, package, SLOC, operator. */
  q: string;
  range: MovementRange;
  sort: MovementSort;
  dir: "asc" | "desc";
}

export const EMPTY_MOVEMENT_FILTER: MovementFilter = {
  wh: "",
  type: [],
  direction: "",
  flow: "",
  category: "",
  productType: "",
  status: "",
  sloc: "",
  operator: "",
  q: "",
  range: "7d",
  sort: "at",
  dir: "desc",
};

const TYPE_SET = new Set<string>(MOVEMENT_TYPES);
const DIRECTION_SET = new Set<string>(MOVEMENT_DIRECTIONS);
const FLOW_SET = new Set<string>(MOVEMENT_FLOWS);
const RANGE_SET = new Set<string>(MOVEMENT_RANGES);
const SORT_SET = new Set<string>(MOVEMENT_SORTS);

/** Jam yang dicakup sebuah rentang; `all` tidak dibatasi. */
export const RANGE_HOURS: Record<MovementRange, number | null> = {
  "24h": 24,
  "72h": 72,
  "7d": 24 * 7,
  "30d": 24 * 30,
  all: null,
};

/** Normalisasi query string apa pun menjadi filter yang aman dipakai di SQL. */
export function parseMovementFilter(params: URLSearchParams): MovementFilter {
  const types = (params.get("type") ?? "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => TYPE_SET.has(value)) as MovementType[];
  const direction = (params.get("direction") ?? "").trim().toUpperCase();
  const flow = (params.get("flow") ?? "").trim().toUpperCase();
  const range = (params.get("range") ?? "7d").trim().toLowerCase();
  const sort = (params.get("sort") ?? "at").trim().toLowerCase();

  return {
    wh: (params.get("wh") ?? "").trim().toUpperCase().slice(0, 12),
    type: [...new Set(types)],
    direction: (DIRECTION_SET.has(direction) ? direction : "") as MovementDirection | "",
    flow: (FLOW_SET.has(flow) ? flow : "") as MovementFlow | "",
    category: (params.get("category") ?? "").trim().slice(0, 120),
    productType: (params.get("productType") ?? "").trim().slice(0, 120),
    status: (params.get("status") ?? "").trim().slice(0, 120),
    sloc: (params.get("sloc") ?? "").trim().toUpperCase().slice(0, 60),
    operator: (params.get("operator") ?? "").trim().slice(0, 120),
    q: (params.get("q") ?? "").trim().slice(0, 120),
    range: (RANGE_SET.has(range) ? range : "7d") as MovementRange,
    sort: (SORT_SET.has(sort) ? sort : "at") as MovementSort,
    dir: params.get("dir") === "asc" ? "asc" : "desc",
  };
}

/** Kebalikan parseMovementFilter — dipakai klien menyusun URL data & ekspor. */
export function movementFilterParams(filter: MovementFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.wh) params.set("wh", filter.wh);
  if (filter.type.length) params.set("type", filter.type.join(","));
  if (filter.direction) params.set("direction", filter.direction);
  if (filter.flow) params.set("flow", filter.flow);
  if (filter.category) params.set("category", filter.category);
  if (filter.productType) params.set("productType", filter.productType);
  if (filter.status) params.set("status", filter.status);
  if (filter.sloc) params.set("sloc", filter.sloc);
  if (filter.operator) params.set("operator", filter.operator);
  if (filter.q) params.set("q", filter.q);
  if (filter.range !== "7d") params.set("range", filter.range);
  if (filter.sort !== "at") params.set("sort", filter.sort);
  if (filter.dir !== "desc") params.set("dir", filter.dir);
  return params;
}

/** Kriteria aktif di luar rentang waktu — dipakai badge "n filter". */
export function activeMovementFilterCount(filter: MovementFilter): number {
  return [
    filter.wh,
    filter.type.length ? "type" : "",
    filter.direction,
    filter.flow,
    filter.category,
    filter.productType,
    filter.status,
    filter.sloc,
    filter.operator,
    filter.q,
  ].filter(Boolean).length;
}

export function isDefaultMovementFilter(filter: MovementFilter): boolean {
  return activeMovementFilterCount(filter) === 0 && filter.range === EMPTY_MOVEMENT_FILTER.range;
}

// ---- bentuk baris yang dikirim ke klien ------------------------------------

export interface MovementRow {
  movement_uid: string;
  at: string;
  updated_at: string | null;
  wh: string;
  location_name: string;
  invoice_number: string;
  product_id: number | null;
  product_name: string;
  sku_number: string;
  l1_category: string;
  product_type: string;
  source_sloc: string | null;
  destination_sloc: string | null;
  action_raw: string;
  movement_type: MovementType;
  direction: MovementDirection;
  flow: MovementFlow;
  from_package: string | null;
  to_package: string | null;
  from_status: string | null;
  to_status: string | null;
  operator: string;
  qty: number;
  qty_signed: number;
}

export interface MovementSummary {
  /** Baris pergerakan yang cocok dengan filter. */
  events: number;
  qty_in: number;
  qty_out: number;
  qty_net: number;
  sku_count: number;
  operator_count: number;
  invoice_count: number;
  sloc_count: number;
  by_type: Partial<Record<MovementType, number>>;
  first_at: string | null;
  last_at: string | null;
}

/** Satu ember waktu pada grafik aktivitas (per jam atau per hari). */
export interface MovementBucket {
  t: string;
  qty_in: number;
  qty_out: number;
  events: number;
}

/** Ringkasan pergerakan satu gudang — inti dari "Recent movements per WH". */
export interface MovementWarehouseRow {
  wh: string;
  name: string;
  events: number;
  qty_in: number;
  qty_out: number;
  qty_net: number;
  sku_count: number;
  operator_count: number;
  last_at: string | null;
}

export interface MovementFacets {
  warehouses: Array<{ code: string; name: string; events: number }>;
  categories: string[];
  product_types: string[];
  statuses: string[];
  operators: string[];
  /** Aksi mentah yang benar-benar ada, beserta tipe kanoniknya. */
  actions: Array<{ raw: string; type: MovementType; events: number }>;
}

export const EMPTY_MOVEMENT_SUMMARY: MovementSummary = {
  events: 0, qty_in: 0, qty_out: 0, qty_net: 0,
  sku_count: 0, operator_count: 0, invoice_count: 0, sloc_count: 0,
  by_type: {}, first_at: null, last_at: null,
};
