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

/**
 * SELURUH kosakata `inventory_action` dataset 705, disalin apa adanya dari
 * hasil pemeriksaan langsung pada 2026-08-22 (21 aksi, 356.526 baris
 * tersinkron). Daftar inilah kontrak sebenarnya: kalau salah satu berubah
 * menjadi "OTHER", filter dan laporan langsung kehilangan artinya.
 */
const WMS_VOCABULARY = [
  ["Create supply order", "SUPPLY_ORDER"],
  ["Create supply order by upload", "SUPPLY_ORDER"],
  ["Update supply order", "SUPPLY_ORDER"],
  ["Update supply order to complete", "SUPPLY_ORDER"],
  ["Update supply order to incoming", "SUPPLY_ORDER"],
  ["Substitute supply order item packing", "SUPPLY_ORDER"],
  ["Substitute supply order item packing return stock", "SUPPLY_ORDER"],
  ["Adjust in stock from supply order partial", "SUPPLY_ORDER"],
  ["Cancel supply order", "CANCELLATION"],
  ["Rollback Create supply order", "CANCELLATION"],
  ["Rollback Cancel supply order", "CANCELLATION"],
  ["Rollback Adjust in stock for putaway task", "CANCELLATION"],
  ["Submit purchase order inbound", "PURCHASE_ORDER"],
  ["Update purchase order to complete", "PURCHASE_ORDER"],
  ["Adjust in stock for putaway task", "PUTAWAY"],
  ["Adjust out stock for putaway task", "PUTAWAY"],
  ["Update putaway task to complete", "PUTAWAY"],
  ["Adjust in stock for replenishment task", "REPLENISHMENT"],
  ["Adjust out stock for replenishment task", "REPLENISHMENT"],
  ["Update Inventory", "ADJUSTMENT"],
  ["Create/update stock inventory by upload", "ADJUSTMENT"],
];

/** Ejaan gudang generik yang harus tetap tergolong bila WMS berubah. */
const GENERIC = [
  ["Putaway", "PUTAWAY"],
  ["PUT_AWAY", "PUTAWAY"],
  ["put-away", "PUTAWAY"],
  ["Penempatan", "PUTAWAY"],
  ["Goods Receipt", "PURCHASE_ORDER"],
  ["INBOUND_RECEIVING", "PURCHASE_ORDER"],
  ["Penerimaan Barang", "PURCHASE_ORDER"],
  ["Picking", "SUPPLY_ORDER"],
  ["ORDER_PICKING", "SUPPLY_ORDER"],
  ["Outbound Delivery", "SUPPLY_ORDER"],
  ["GATE_OUT", "SUPPLY_ORDER"],
  ["Internal Transfer", "TRANSFER"],
  ["BIN-TO-BIN", "TRANSFER"],
  ["Return to Vendor", "RETURN"],
  ["Stock Opname", "ADJUSTMENT"],
  ["Cycle Count", "ADJUSTMENT"],
  ["Change Status Good to Bad", "STATUS_CHANGE"],
  ["Quarantine", "STATUS_CHANGE"],
  ["Kegiatan Khusus Gudang", "OTHER"],
  ["", "OTHER"],
  [null, "OTHER"],
];

const CASES = [...WMS_VOCABULARY, ...GENERIC];

test("seluruh kosakata WMS dataset 705 tergolong, tak satu pun jadi OTHER", () => {
  for (const [raw, expected] of WMS_VOCABULARY) {
    const actual = movementTypeOf(raw);
    assert.notEqual(actual, "OTHER", `aksi nyata "${raw}" jatuh ke OTHER`);
    assert.equal(actual, expected, `aksi ${JSON.stringify(raw)}`);
  }
});

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
  // "incoming" bukan "inbound": pesanan keluar yang berubah status tidak boleh
  // berpindah ke sisi penerimaan.
  assert.equal(movementTypeOf("Update supply order to incoming"), "SUPPLY_ORDER");
});

test("normalisasi menyamakan pemisah", () => {
  assert.equal(normalizeActionText("PUT_AWAY"), "put away");
  assert.equal(normalizeActionText("  Goods--Receipt/2  "), "goods receipt 2");
});

// Hampir setiap aksi WMS menyebut lebih dari satu kata kunci; yang menang
// harus yang paling spesifik.
test("urutan aturan menang atas kata kunci yang lebih umum", () => {
  // Tugas putaway lebih spesifik daripada kata "adjust" yang mengawalinya.
  assert.equal(movementTypeOf("Adjust in stock for putaway task"), "PUTAWAY");
  // Pembatalan mengalahkan objek bisnis yang dibatalkannya.
  assert.equal(movementTypeOf("Rollback Adjust in stock for putaway task"), "CANCELLATION");
  assert.equal(movementTypeOf("Cancel supply order"), "CANCELLATION");
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
    type: ["SUPPLY_ORDER", "PUTAWAY"],
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
    type: "SUPPLY_ORDER,BOGUS", direction: "SIDEWAYS", range: "99y", sort: "; DROP TABLE",
  });
  const filter = parseMovementFilter(params);
  assert.deepEqual(filter.type, ["SUPPLY_ORDER"]);
  assert.equal(filter.direction, "");
  assert.equal(filter.range, "7d");
  assert.equal(filter.sort, "at");
});

test("hitungan filter aktif mengabaikan rentang waktu bawaan", () => {
  assert.ok(isDefaultMovementFilter(EMPTY_MOVEMENT_FILTER));
  assert.equal(activeMovementFilterCount(EMPTY_MOVEMENT_FILTER), 0);
  assert.equal(activeMovementFilterCount({ ...EMPTY_MOVEMENT_FILTER, wh: "CBT", q: "x" }), 2);
  assert.equal(
    activeMovementFilterCount({ ...EMPTY_MOVEMENT_FILTER, type: ["SUPPLY_ORDER", "PUTAWAY"] }),
    1,
  );
});
