// SLOC mana yang benar-benar berubah isinya oleh sebuah pergerakan.
//
// KENAPA INI PANTAS DIUJI TERSENDIRI
// ----------------------------------
// Kolom "Penyebab" pada Penjelajah SLOC — dan angka yang ikut ke berkas Excel —
// seluruhnya bergantung pada satu keputusan: rak mana yang bertambah isinya.
// Keputusan itu TIDAK dapat dibaca dari `destination_sloc` saja. Diperiksa
// langsung pada dataset 705 (2026-08-22, 356.526 baris dalam 24 jam):
//
//   - 103.630 baris bertanda `+`, tetapi hanya 9.453 yang punya
//     `destination_sloc`. Sisanya — termasuk 368 ribu unit putaway dan 264 ribu
//     unit penerimaan PO — menuliskan raknya pada `source_sloc`.
//   - Pemindahan antar-rak ditulis sebagai DUA baris kembar dengan pasangan
//     asal→tujuan yang sama dan tanda berlawanan.
//
// Dua sifat itulah yang diuji di bawah: membaca kolom tujuan saja melewatkan
// kegiatan yang paling sering membuat rak penuh, dan mengabaikan tanda membuat
// satu pemindahan terhitung masuk pada kedua raknya sekaligus.
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
  (id) => { throw new Error(`Unexpected runtime import in movement impact test: ${id}`); },
  moduleRecord,
  moduleRecord.exports,
);

const {
  movementAddsTo, movementImpactSloc, movementImpactSlocSQL, slocGainSQL,
} = moduleRecord.exports;

test("putaway & penerimaan: rak yang bertambah ada di source_sloc", () => {
  // "Adjust in stock for putaway task" — bentuk paling umum penambahan stok.
  assert.equal(movementImpactSloc("CBT-SRA1-01-01-L1-01", "", "IN"), "CBT-SRA1-01-01-L1-01");
  assert.equal(movementImpactSloc("CBT-SRA1-01-01-L1-01", null, "IN"), "CBT-SRA1-01-01-L1-01");
  // Penerimaan yang hanya menyebut tujuan tetap terbaca.
  assert.equal(movementImpactSloc(null, "BGO-PLA1-01-01-L1-05", "IN"), "BGO-PLA1-01-01-L1-05");
});

test("pemindahan antar-rak: tanda menentukan sisi mana yang berubah", () => {
  const from = "BIT-STG1-ID-01-L1-21";
  const to = "BIT-CHA1-18-02-L4-02";
  // Baris `+` menambah rak TUJUAN.
  assert.equal(movementImpactSloc(from, to, "IN"), to);
  // Baris kembarnya `−` mengurangi rak ASAL.
  assert.equal(movementImpactSloc(from, to, "OUT"), from);
  // Tanpa tanda yang jelas, tujuan tetap pilihan yang paling masuk akal.
  assert.equal(movementImpactSloc(from, to, "NEUTRAL"), to);
});

test("baris tanpa rak sama sekali tidak mengaku menyentuh lokasi mana pun", () => {
  assert.equal(movementImpactSloc("", "", "IN"), null);
  assert.equal(movementImpactSloc(null, null, "OUT"), null);
  assert.equal(movementImpactSloc("   ", "", "IN"), null);
});

test("asal dan tujuan yang sama bukan pemindahan", () => {
  const sloc = "SRG-ABB1-02-03-L2-01";
  assert.equal(movementImpactSloc(sloc, sloc, "IN"), sloc);
  assert.equal(movementImpactSloc(sloc, sloc, "OUT"), sloc);
});

test("spasi di sekitar kode tidak membuat lokasi terbaca berbeda", () => {
  assert.equal(movementImpactSloc(" CBT-SRA1-01 ", "", "IN"), "CBT-SRA1-01");
});

test("hanya penambahan yang dihitung sebagai 'menaruh barang di sini'", () => {
  const sloc = "CBT-SRA1-01-01-L1-01";
  const putaway = { source_sloc: sloc, destination_sloc: null, direction: "IN" };
  const picking = { source_sloc: sloc, destination_sloc: null, direction: "OUT" };
  assert.equal(movementAddsTo(putaway, sloc), true);
  // Pengambilan barang dari rak yang sama BUKAN penyebab rak itu penuh.
  assert.equal(movementAddsTo(picking, sloc), false);
  // Lokasi lain tidak boleh ikut tertandai.
  assert.equal(movementAddsTo(putaway, "CBT-SRA1-01-01-L1-02"), false);
});

test("pada pemindahan, hanya rak tujuan yang dianggap bertambah", () => {
  const from = "BIT-STG1-ID-01-L1-21";
  const to = "BIT-CHA1-18-02-L4-02";
  const gain = { source_sloc: from, destination_sloc: to, direction: "IN" };
  const loss = { source_sloc: from, destination_sloc: to, direction: "OUT" };
  assert.equal(movementAddsTo(gain, to), true);
  // Kekeliruan yang dicegah: satu pemindahan terhitung masuk pada KEDUA rak.
  assert.equal(movementAddsTo(gain, from), false);
  assert.equal(movementAddsTo(loss, from), false);
  assert.equal(movementAddsTo(loss, to), false);
});

// SQL dibangkitkan dari aturan yang sama. Uji ini menjaga agar padanan servernya
// tetap membaca KEDUA kolom dan tetap memakai tanda — bukan menyusut kembali
// menjadi `destination_sloc` saja.
test("movementImpactSlocSQL memakai asal, tujuan, dan tanda sekaligus", () => {
  const sql = movementImpactSlocSQL("v.source_sloc", "v.destination_sloc", "v.operator_sign");
  assert.ok(sql.includes("v.source_sloc"), "kolom asal tidak dipakai");
  assert.ok(sql.includes("v.destination_sloc"), "kolom tujuan tidak dipakai");
  assert.ok(sql.includes("v.operator_sign"), "tanda tidak ikut menentukan sisi");
  assert.ok(sql.includes("'OUT'"), "cabang pengurangan hilang");
  assert.ok(sql.includes("coalesce("), "baris tanpa tujuan harus jatuh ke kolom asal");
  assert.ok(sql.trim().startsWith("CASE") && sql.trim().endsWith("END"));
});

// Relasi penambahan per lokasi harus dibangun dari definisi yang sama dengan
// yang diuji di atas, DAN harus dimaterialisasi sekali per snapshot. Keduanya
// gampang hilang tanpa terlihat: yang pertama membuat kolom penyebab melewatkan
// putaway, yang kedua membuat Penjelajah SLOC memindai jutaan baris pergerakan
// pada setiap ketikan.
test("slocGainSQL memakai definisi bersama dan menyaring hanya penambahan", () => {
  const sql = slocGainSQL();
  assert.ok(sql.includes("v.source_sloc"), "kolom asal tidak dipakai");
  assert.ok(sql.includes("v.destination_sloc"), "kolom tujuan tidak dipakai");
  assert.ok(sql.includes("v.operator_sign"), "tanda tidak ikut menentukan sisi");
  assert.ok(sql.includes("= 'IN'"), "pengurangan stok ikut terhitung sebagai penambahan");
  assert.ok(sql.includes("qty_in") && sql.includes("events"), "total penambahan hilang");
  // Yang dipilih harus penambahan TERAKHIR, dengan pemecah seri yang tetap:
  // dua baris dapat berbagi detik yang sama pada lokasi tersibuk.
  assert.ok(sql.includes("arg_max("), "baris terakhir tidak dipilih lewat agregat");
  assert.ok(sql.includes("(created_at, movement_uid)"), "pemecah seri hilang — hasilnya jadi acak");
  // arg_max MELEWATI baris yang argumennya NULL. Satu arg_max per kolom karena
  // itu akan mengambil `from_sloc` milik pergerakan lain yang lebih tua —
  // terukur 863 lokasi salah pada data sehari. Satu struct mencegahnya.
  assert.equal(
    (sql.match(/arg_max\(/g) ?? []).length, 1,
    "arg_max per kolom akan mengambil from_sloc dari pergerakan yang lebih tua",
  );
  // Taksonomi aksi berubah bersama kode, sedangkan replika hanya dibangun ulang
  // saat ada snapshot baru. Menyimpan tipenya membuat label tertinggal.
  assert.ok(!sql.includes("movement_type"), "tipe aksi tidak boleh ikut dibekukan ke replika");
});

test("relasi penambahan dimaterialisasi sekali per snapshot", () => {
  const db = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
  assert.ok(db.includes("slocGainSQL()"), "vw_sloc_gain tidak dibangun dari definisi bersama");
  assert.ok(
    db.includes("CREATE OR REPLACE TABLE _sloc_gain_current"),
    "relasi penambahan tidak dimaterialisasi — penjelajah akan memindai ulang tiap ketikan",
  );
});

// Kolom penyebab pada tabel dan pada Excel harus berasal dari relasi yang sama.
// Membaca teks sumbernya adalah satu-satunya cara menjamin kueri BARU tidak
// diam-diam kembali menyusun definisinya sendiri.
test("read-model penjelajah SLOC membaca relasi penambahan bersama", () => {
  const queries = readFileSync(new URL("../lib/queries.ts", import.meta.url), "utf8");
  const attach = queries.slice(
    queries.indexOf("async function attachSlocCauses"),
    queries.indexOf("/** Halaman tabel + ringkasan"),
  );
  assert.ok(attach.length > 0, "attachSlocCauses tidak ditemukan");
  assert.ok(attach.includes("FROM vw_sloc_gain g"), "kueri penyebab tidak memakai relasi bersama");
  assert.ok(
    !attach.includes("destination_sloc"),
    "kueri penyebab menyusun definisinya sendiri dari kolom tujuan",
  );
  // Tabel DAN ekspor harus melewati fungsi yang sama.
  assert.ok(
    queries.includes("await attachSlocCauses(rows.map(toExplorerRow))")
      && queries.includes("return attachSlocCauses(rows.map(toExplorerRow))"),
    "halaman dan ekspor tidak memakai jalur penyebab yang sama",
  );
});
