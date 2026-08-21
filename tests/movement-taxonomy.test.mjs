// Standardisasi aksi pergerakan harus stabil DAN identik antara TypeScript dan
// SQL. Keduanya dibangkitkan dari satu tabel aturan, tetapi hanya uji ini yang
// membuktikan hasilnya benar-benar sama — dan bahwa ejaan seperti "PUT_AWAY"
// tidak diam-diam jatuh ke "Lainnya" seperti sebelumnya.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../lib/movements.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: "movements.ts",
}).outputText;

const moduleRecord = { exports: {} };
new Function("require", "module", "exports", compiled)(
  (id) => { throw new Error(`Unexpected runtime import in movement test: ${id}`); },
  moduleRecord,
  moduleRecord.exports,
);

const {
  MOVEMENT_TYPES,
  EMPTY_MOVEMENT_FILTER,
  activeMovementFilterCount,
  isDefaultMovementFilter,
  movementDirectionOf,
  movementFilterParams,
  movementTypeOf,
  movementTypeSQL,
  normalizeActionText,
  parseMovementFilter,
} = moduleRecord.exports;

/** Ejaan nyata dari WMS → tipe kanonik yang diharapkan. */
const CASES = [
  ["Putaway", "PUTAWAY"],
  ["PUT_AWAY", "PUTAWAY"],
  ["put-away", "PUTAWAY"],
  ["Put Away From Staging", "PUTAWAY"],
  ["Penempatan", "PUTAWAY"],
  ["Goods Receipt", "RECEIVING"],
  ["INBOUND_RECEIVING", "RECEIVING"],
  ["Penerimaan Barang", "RECEIVING"],
  ["Picking", "PICKING"],
  ["ORDER_PICKING", "PICKING"],
  ["Pengambilan Order", "PICKING"],
  ["Packing", "PACKING"],
  ["Outbound Delivery", "DISPATCH"],
  ["GATE_OUT", "DISPATCH"],
  ["Pengiriman", "DISPATCH"],
  ["Internal Transfer", "TRANSFER"],
  ["Pemindahan Rak", "TRANSFER"],
  ["BIN-TO-BIN", "TRANSFER"],
  ["Return to Vendor", "RETURN"],
  ["Retur Customer", "RETURN"],
  ["Stock Opname Adjustment", "ADJUSTMENT"],
  ["Cycle Count", "ADJUSTMENT"],
  ["Change Status Good to Bad", "STATUS_CHANGE"],
  ["Quarantine", "STATUS_CHANGE"],
  ["Kegiatan Khusus Gudang", "OTHER"],
  ["", "OTHER"],
  [null, "OTHER"],
];

test("aksi mentah dipetakan ke tipe kanonik yang benar", () => {
  for (const [raw, expected] of CASES) {
    assert.equal(movementTypeOf(raw), expected, `aksi ${JSON.stringify(raw)}`);
  }
});

test("setiap tipe yang dihasilkan ada di MOVEMENT_TYPES", () => {
  for (const [raw] of CASES) {
    assert.ok(MOVEMENT_TYPES.includes(movementTypeOf(raw)));
  }
});

// "remove" adalah pengurangan stok, bukan pemindahan. Pencocokan substring
// polos akan menggolongkannya sebagai TRANSFER dan membalik makna barisnya.
test("batas kata mencegah salah golong", () => {
  assert.equal(movementTypeOf("Remove Damaged Unit"), "STATUS_CHANGE");
  assert.equal(movementTypeOf("Repack Carton"), "OTHER");
});

test("normalisasi menyamakan pemisah", () => {
  assert.equal(normalizeActionText("PUT_AWAY"), "put away");
  assert.equal(normalizeActionText("  Goods--Receipt/2  "), "goods receipt 2");
});

// Aturan yang lebih spesifik harus menang: "Stock Opname Transfer" adalah
// penyesuaian, bukan pemindahan.
test("urutan aturan menang atas kata kunci yang lebih umum", () => {
  assert.equal(movementTypeOf("Stock Opname Transfer"), "ADJUSTMENT");
  assert.equal(movementTypeOf("Return Putaway"), "RETURN");
});

test("arah stok dibaca sebagai token utuh", () => {
  assert.equal(movementDirectionOf("+"), "IN");
  assert.equal(movementDirectionOf("-"), "OUT");
  assert.equal(movementDirectionOf("Plus"), "IN");
  // "minus" mengandung "in"; pencocokan longgar akan membalik tandanya.
  assert.equal(movementDirectionOf("minus"), "OUT");
  assert.equal(movementDirectionOf("-1"), "OUT");
  assert.equal(movementDirectionOf(""), "NEUTRAL");
  assert.equal(movementDirectionOf("???"), "NEUTRAL");
});

// SQL dibangkitkan dari tabel aturan yang sama. Uji ini menjaga agar setiap
// tipe punya cabang CASE-nya sendiri dan tidak ada kutip yang bocor ke SQL.
test("movementTypeSQL mencakup semua tipe dan tidak menyisipkan kolom mentah", () => {
  const sql = movementTypeSQL("v.action_raw");
  for (const type of MOVEMENT_TYPES) {
    assert.ok(sql.includes(`'${type}'`), `cabang ${type} hilang`);
  }
  assert.ok(sql.startsWith("CASE ") && sql.endsWith(" END"));
  assert.ok(sql.includes("regexp_replace"), "teks aksi harus dinormalkan di SQL juga");
});

test("filter bolak-balik lewat query string tanpa berubah", () => {
  const filter = {
    ...EMPTY_MOVEMENT_FILTER,
    wh: "CBT",
    type: ["PICKING", "DISPATCH"],
    direction: "OUT",
    flow: "OUTBOUND",
    category: "Kebutuhan Pokok",
    productType: "Fresh",
    status: "Bad",
    sloc: "CBT-SRA1",
    operator: "Budi Santoso",
    q: "indomie",
    range: "24h",
    sort: "qty",
    dir: "asc",
  };
  assert.deepEqual(parseMovementFilter(movementFilterParams(filter)), filter);
});

test("masukan tak dikenal jatuh ke nilai bawaan yang aman", () => {
  const params = new URLSearchParams({
    type: "PICKING,BOGUS", direction: "SIDEWAYS", range: "99y", sort: "; DROP TABLE",
  });
  const filter = parseMovementFilter(params);
  assert.deepEqual(filter.type, ["PICKING"]);
  assert.equal(filter.direction, "");
  assert.equal(filter.range, "7d");
  assert.equal(filter.sort, "at");
});

test("hitungan filter aktif mengabaikan rentang waktu bawaan", () => {
  assert.ok(isDefaultMovementFilter(EMPTY_MOVEMENT_FILTER));
  assert.equal(activeMovementFilterCount(EMPTY_MOVEMENT_FILTER), 0);
  assert.equal(activeMovementFilterCount({ ...EMPTY_MOVEMENT_FILTER, wh: "CBT", q: "x" }), 2);
  assert.equal(
    activeMovementFilterCount({ ...EMPTY_MOVEMENT_FILTER, type: ["PICKING", "PACKING"] }),
    1,
  );
});
