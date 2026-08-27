// Resolver kapasitas: urutan menang, dimensi SKU, dan pembersihan scope.
//
// Kapasitas adalah penyebut setiap persentase okupansi di aplikasi ini, jadi
// satu kesalahan urutan menang di sini muncul sebagai angka yang salah pada
// heatmap, alert, ekspor, dan proyeksi sekaligus — tanpa satu pun pesan galat.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const moduleCache = new Map();

function compile(source, fileName) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName,
  }).outputText;
}

/**
 * Muat modul `@/lib/*` yang sesungguhnya, dengan lib/config.ts diganti stub.
 *
 * lib/config.ts membaca berkas dari disk dan menyiapkan penyimpanan runtime
 * saat dimuat; yang diuji di sini adalah aturannya, bukan tempat berkasnya.
 */
function loadLib(specifier, stubs) {
  if (stubs[specifier]) return stubs[specifier];
  if (moduleCache.has(specifier)) return moduleCache.get(specifier);
  const relative = specifier.replace(/^@\/lib\//, "");
  const file = new URL(`../lib/${relative}.ts`, import.meta.url);
  const code = compile(readFileSync(file, "utf8"), `${relative}.ts`);
  const record = { exports: {} };
  moduleCache.set(specifier, record.exports);
  new Function("require", "module", "exports", code)(
    (id) => (id.startsWith("@/lib/") ? loadLib(id, stubs) : require(id)),
    record,
    record.exports,
  );
  moduleCache.set(specifier, record.exports);
  return record.exports;
}

const schema = loadLib("@/lib/config-schema", {});

/** Parse lewat skema yang sesungguhnya, sehingga tes ikut menguji normalisasi. */
function capacityConfig(raw) {
  return schema.CONFIG_SCHEMAS.capacity.parse(raw);
}

function resolverFor(raw) {
  const config = capacityConfig(raw);
  moduleCache.delete("@/lib/capacity");
  return loadLib("@/lib/capacity", { "@/lib/config": { getCapacity: () => config } });
}

const location = (overrides = {}) => ({
  wh: "CBT", zone: "HRA", rack_zone: "HRA1", aisle: "01", bay: "02",
  level: "2", bin: "01", storage: "Ambient",
  max_quantity: 40, max_volume: 0.05,
  ...overrides,
});

test("the lowest matching rule wins, exactly as the editor promises", () => {
  const capacity = resolverFor({
    utilization_pct: 100,
    rules: [
      { scope: { wh: "CBT" }, set: { max_qty: 100 } },
      { scope: { wh: "CBT", zone: "HRA" }, set: { max_qty: 72, max_cbm: 0.0658 } },
    ],
  });
  const resolved = capacity.resolveSloc(location());
  assert.equal(resolved.cap_qty, 72);
  assert.equal(resolved.cap_cbm_nominal, 0.0658);
});

test("volume utilisation derates CBM capacity and never Qty", () => {
  const capacity = resolverFor({
    utilization_pct: 85,
    rules: [{ scope: { wh: "CBT" }, set: { max_qty: 100, max_cbm: 1 } }],
  });
  const resolved = capacity.resolveSloc(location());
  assert.equal(resolved.cap_qty, 100);
  assert.equal(resolved.cap_cbm_nominal, 1);
  assert.equal(resolved.cap_cbm, 0.85);
});

test("a category scope decides counting, never capacity", () => {
  const capacity = resolverFor({
    exclude_categories: [],
    rules: [
      { scope: { wh: "CBT", zone: "HRA" }, set: { max_qty: 72 } },
      { scope: { wh: "CBT", l1_category: "Daging Beku" }, set: { count: false } },
    ],
  });
  assert.equal(capacity.resolveSloc(location()).cap_qty, 72);
  assert.equal(capacity.categoryCounted("Daging Beku", location()), false);
  assert.equal(capacity.categoryCounted("Ayam & Unggas", location()), true);
});

// ---- Normalisasi skema ------------------------------------------------------

test("a mistyped scope key is dropped instead of being stored as a rule that never matches", () => {
  // Sebelumnya `catchall(z.string())` menerima kunci apa pun dan resolver
  // mengabaikannya: aturannya tersimpan, tampil di editor, dan tidak pernah
  // cocok dengan satu lokasi pun.
  const parsed = capacityConfig({
    rules: [{ scope: { wh: "CBT", zona: "HRA" }, set: { max_qty: 10 }, note: "" }],
  });
  assert.deepEqual(parsed.rules[0].scope, { wh: "CBT" });
});

test("blank rules left behind by Add rule never reach the saved file", () => {
  const parsed = capacityConfig({
    rules: [
      { scope: {}, set: {}, note: "" },
      { scope: { wh: "CBT" }, set: { max_qty: 10 }, note: "" },
      { scope: {}, set: {}, note: "" },
    ],
  });
  assert.equal(parsed.rules.length, 1);
});

test("a category rule may only decide counting, never capacity", () => {
  assert.throws(
    () => capacityConfig({
      rules: [{ scope: { l1_category: "Daging Beku" }, set: { max_qty: 10 }, note: "" }],
    }),
    /hanya boleh mengatur/,
  );
  assert.throws(
    () => capacityConfig({ rules: [{ scope: { wh: "CBT" }, set: { count: false }, note: "" }] }),
    /hanya berlaku untuk scope ber-kategori/,
  );
});

// ---- Standar CBM per SKU ----------------------------------------------------
//
// Volume terpakai pada dataset stok adalah `stock_qty × sku_cbm`. Standar di
// sini menggantikan `sku_cbm`, sehingga ia menggeser PEMBILANG setiap rasio
// volume — bukan kapasitas lokasinya.

function skuStandards(raw) {
  return schema.CONFIG_SCHEMAS["sku-standards"].parse(raw);
}

test("a SKU standard is normalised to upper case so trailing master data cannot miss it", () => {
  const parsed = skuStandards({
    standards: [{ sku: "  abc-99 ", unit_cbm: 0.0125, note: "ukur ulang" }],
  });
  assert.equal(parsed.standards[0].sku, "ABC-99");
  assert.equal(parsed.standards[0].unit_cbm, 0.0125);
});

test("the same SKU cannot be given two standards", () => {
  assert.throws(
    () => skuStandards({
      standards: [
        { sku: "A1", unit_cbm: 0.01 },
        { sku: "a1", unit_cbm: 0.02 },
      ],
    }),
    /sudah diatur pada baris 1/,
  );
});

test("a zero or negative standard is refused before it can divide by nothing", () => {
  assert.throws(() => skuStandards({ standards: [{ sku: "A1", unit_cbm: 0 }] }), /lebih besar dari 0/);
  assert.throws(() => skuStandards({ standards: [{ sku: "A1", unit_cbm: -1 }] }), /lebih besar dari 0/);
});

test("an empty standards file is valid, so a fresh install needs no seeding", () => {
  assert.deepEqual(skuStandards({}).standards, []);
});

test("cross-file coherence catches warehouse codes that would silently do nothing", () => {
  const warehouses = { warehouses: [{ code: "CBT", location_id: 819, name: "Cibitung" }] };
  const problems = schema.checkConfigCoherence({
    "warehouses.json": schema.CONFIG_SCHEMAS.warehouses.parse(warehouses),
    "capacity.json": capacityConfig({
      disabled_zones: [{ wh: "XXX", zone: "STG", note: "" }],
    }),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /XXX\/STG/);
});

test("an unknown warehouse on a rule scope is not a save blocker", () => {
  // Aturan yang tidak cocok dengan apa pun bersifat aditif: ia tidak merusak
  // angka mana pun. Menolak penyimpanan karenanya berarti sebuah gudang tidak
  // dapat dihapus selama masih ada aturan lama yang menyebutnya.
  const problems = schema.checkConfigCoherence({
    "warehouses.json": schema.CONFIG_SCHEMAS.warehouses.parse({
      warehouses: [{ code: "CBT", location_id: 819, name: "Cibitung" }],
    }),
    "capacity.json": capacityConfig({
      rules: [{ scope: { wh: "SUDAH-TIDAK-ADA" }, set: { max_qty: 10 }, note: "" }],
    }),
  });
  assert.deepEqual(problems, []);
});

test("the repository configuration still parses under the tightened schema", () => {
  // Konfigurasi yang sedang dipakai instalasi ini harus tetap terbaca: skema
  // yang lebih ketat tidak boleh membuat deployment yang berjalan gagal start.
  const root = new URL("../", import.meta.url);
  for (const file of ["config/capacity.json", "db/runtime-config/capacity.json"]) {
    const full = new URL(file, root);
    let raw;
    try {
      raw = JSON.parse(readFileSync(full, "utf8"));
    } catch {
      continue; // instalasi baru belum punya berkas runtime
    }
    assert.doesNotThrow(() => capacityConfig(raw), `${path.basename(file)} harus tetap terbaca`);
  }
});

// ---- Satu pintu untuk setiap pembacaan stok ---------------------------------
//
// Standar CBM hanya berarti bila SETIAP layar memakainya. Satu kueri baru yang
// membaca `vw_stock_latest` langsung akan menampilkan angka sumber data di
// tengah layar-layar lain yang memakai angka admin — dan perbedaan itu tidak
// akan muncul sebagai galat, hanya sebagai dua halaman yang tidak sepakat.
// Karena itu invariannya diuji terhadap sumbernya, bukan terhadap ingatan.

test("every dashboard stock read goes through the SKU standard wrapper", () => {
  const source = readFileSync(new URL("../lib/queries.ts", import.meta.url), "utf8");
  // Batasnya jelas dan disengaja: segala sesuatu yang menyajikan angka ke layar
  // wajib lewat STOCK(). Bagian "Katalog SKU" sesudahnya justru harus membaca
  // nilai MENTAH — ia menampilkan angka sumber data berdampingan dengan
  // penggantinya, dan itu hanya berarti bila ia benar-benar nilai sumber.
  const body = source.slice(
    source.indexOf("// ---- filter bersama"),
    source.indexOf("// ---- Katalog SKU untuk editor standar CBM"),
  );
  const direct = body.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\bvw_stock_latest\b/.test(line))
    // Mesin pembungkusnya sendiri memang menyebut nama view-nya.
    .filter((line) => !line.startsWith("//") && !line.includes("stockSqlMemo"))
    .filter((line) => !line.startsWith("FROM vw_stock_latest\n") && line !== "FROM vw_stock_latest");
  assert.deepEqual(
    direct,
    [],
    "pakai STOCK(), bukan vw_stock_latest, agar standar CBM admin ikut berlaku",
  );
});

test("with no standards saved the generated stock expression is the plain view", () => {
  const source = readFileSync(new URL("../lib/queries.ts", import.meta.url), "utf8");
  // Instalasi yang tidak memakai fitur ini tidak boleh menanggung biayanya:
  // SQL-nya harus identik dengan sebelum fitur ada.
  assert.match(source, /if \(!standards\.length\) return "vw_stock_latest";/);
});

test("the read model fingerprint includes the SKU standards", () => {
  // Tanpa ini, menyimpan standar baru meninggalkan angka lama tersaji dari
  // db/read-model-cache/ — kegagalan yang paling mustahil didiagnosis:
  // setelan tersimpan, layar tidak berubah.
  const source = readFileSync(new URL("../lib/queries.ts", import.meta.url), "utf8");
  const fingerprint = source.slice(
    source.indexOf("function readModelVersion()"),
    source.indexOf("interface SlocMeta"),
  );
  assert.match(fingerprint, /getSkuStandards\(\)/);
  assert.match(fingerprint, /JSON\.stringify\(skuStandards\)/);
});
