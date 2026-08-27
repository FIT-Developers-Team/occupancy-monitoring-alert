// Kalimat alert adalah antarmuka, bukan detail implementasi: ia dibaca di
// ponsel, di tengah lantai gudang, oleh orang yang sedang mengerjakan hal lain.
// Uji ini mengunci tiga hal yang harus selalu ada dalam sekali baca — LOKASI
// mana, SEBERAPA lewat, dan APA yang harus dilakukan — memakai bentuk baris
// yang persis dikembalikan getMovementBreaches() dari basis data sungguhan.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function load(relativePath, stubs = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: relativePath,
  }).outputText;
  const record = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (id) => {
      if (id in stubs) return stubs[id];
      throw new Error(`Unexpected runtime import in alert message test: ${id}`);
    },
    record,
    record.exports,
  );
  return record.exports;
}

// lib/utils menarik kamus i18n; pemformatnya sudah punya ujinya sendiri, jadi
// di sini cukup bentuk Indonesia apa adanya.
const utils = load("../lib/utils.ts", {
  "@/lib/i18n-dict": load("../lib/i18n-dict.ts"),
});
const { buildBreachMessage, excessOf, readingOf, clockOf } =
  load("../lib/alerts/message.ts", { "@/lib/utils": utils });

/** Baris nyata dari basis data ini (CBT-PLA1-01-01-L1-01, 2026-08-22). */
const cbmOnly = {
  sloc_code: "CBT-PLA1-01-01-L1-01",
  pct_qty: 54.8,
  pct_cbm: 5961.7,
  occ_qty: 2190,
  cap_qty: 4000,
  occ_cbm: 85.848,
  cap_cbm: 1.44,
  qty_in: 3832,
  last_at: "2026-08-22T02:29:34+07:00",
  last_operator: "Lyordan Arya Dimas",
};

/** Baris nyata kedua, lewat pada kedua basis sekaligus. */
const dual = {
  sloc_code: "STL-SRA1-23-12-L1-C10",
  pct_qty: 2189,
  pct_cbm: 4267.3,
  occ_qty: 480,
  cap_qty: 21.9,
  occ_cbm: 1.28,
  cap_cbm: 0.03,
  qty_in: 480,
  last_at: "2026-08-22T08:21:00+07:00",
  last_operator: "Angga",
};

test("judul menyatakan lokasinya memang penuh, dengan persentase terparah", () => {
  // Alert kapasitas hanya dibuat ketika KEDUA basis lewat, jadi hanya ada satu
  // bentuk judul. Cabang "hanya satu basis" sengaja tidak ada lagi: kalimat
  // yang tidak akan pernah dikirim tidak perlu dipelihara.
  const { title } = buildBreachMessage(dual);
  assert.equal(title, "STL-SRA1-23-12-L1-C10 penuh — Qty & CBM lewat kapasitas (4.267%)");
});

test("detail selalu menjawab apa yang berubah, siapa, dan berapa", () => {
  const { detail } = buildBreachMessage(dual);
  assert.match(detail, /Masuk 480 unit pukul 08\.21 oleh Angga\./, "penyebabnya disebut lebih dulu");
  assert.match(detail, /Qty 2\.189%/);
  assert.match(detail, /CBM 4\.267%/);
  assert.match(detail, /Pindahkan 459 unit ke lokasi kosong terdekat\./, "tindakannya berupa angka");
});

test("basis tanpa kapasitas sahih tidak pernah muncul sebagai angka", () => {
  const qtyOnly = { ...cbmOnly, pct_cbm: null };
  const reading = readingOf(qtyOnly);
  assert.match(reading, /^Qty /);
  assert.ok(!reading.includes("CBM"), "basis tak terukur dihilangkan, bukan ditulis 0%");
});

test("kelebihan diukur dalam unit selama Qty terukur", () => {
  assert.equal(excessOf(dual), "459 unit");
  // Qty masih di dalam kapasitas, jadi sisanya hanya dapat dinyatakan dalam m³.
  // Desimalnya mengikuti besarannya, sama seperti setiap angka m³ lain di layar.
  assert.equal(excessOf(cbmOnly), "84,4 m³");
});

test("jam ditampilkan dalam WIB apa pun zona waktu proses", () => {
  // 08:21 WIB dinyatakan sebagai instan UTC — hasilnya harus tetap 08.21.
  assert.equal(clockOf("2026-08-22T01:21:00Z"), "08.21");
  assert.equal(clockOf("2026-08-22T08:21:00+07:00"), "08.21");
});
