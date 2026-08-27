// Setiap kunci `t("…")` yang dipakai antarmuka harus ada di KEDUA kamus.
//
// KENAPA INI PANTAS DIUJI
// -----------------------
// `makeT` sengaja jatuh ke kuncinya sendiri ketika terjemahannya tidak ada —
// itu pilihan yang benar (satu label hilang tidak boleh merobohkan halaman),
// tetapi akibatnya kegagalan tampil sebagai TEKS YANG MASUK AKAL. Tidak ada
// error, tidak ada peringatan; hanya sebuah label bertuliskan `nav.audit`.
//
// Persis itu yang terjadi: `nav.audit` dan `nav.guide` tidak pernah ada di
// kamus, sehingga sidebar admin dan palet ⌘K menampilkan dua menu bernama
// "nav.audit" dan "nav.guide" — pada setiap halaman, untuk setiap admin.
// `export.warehouseName` melakukan hal yang sama pada judul kolom lembar
// Excel Gudang. Ketiganya lolos dari review manusia justru karena bentuknya
// terlihat seperti teks.
//
// Uji ini membaca kunci yang benar-benar dipanggil dari kode, bukan daftar
// yang ditulis tangan, jadi ia ikut menjaga kunci yang ditambahkan besok.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));

const compiled = ts.transpileModule(readFileSync(join(root, "lib/i18n-dict.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleRecord = { exports: {} };
new Function("require", "module", "exports", compiled)(
  (id) => { throw new Error(`Unexpected runtime import in i18n test: ${id}`); },
  moduleRecord,
  moduleRecord.exports,
);
const { makeT } = moduleRecord.exports;
const id = makeT("id");

/**
 * Kunci yang benar-benar dimiliki kamus Inggris.
 *
 * `makeT("en")` TIDAK dapat menjawab ini: ia jatuh ke kamus Indonesia sebelum
 * menyerah, sehingga kunci yang hanya ada di sisi Indonesia tetap
 * mengembalikan teks — teks Indonesia, di layar berbahasa Inggris. Satu-satunya
 * cara memeriksanya adalah membaca blok kamusnya sendiri. Batas bloknya ikut
 * diperiksa di bawah, jadi perubahan bentuk berkas gagal dengan berisik alih-
 * alih diam-diam meloloskan segalanya.
 */
const dictSource = readFileSync(join(root, "lib/i18n-dict.ts"), "utf8");
function dictionaryKeys(name) {
  const start = dictSource.indexOf(`const ${name}: Dict = {`);
  if (start < 0) throw new Error(`blok kamus ${name} tidak ditemukan`);
  const end = dictSource.indexOf("\n};", start);
  if (end < 0) throw new Error(`akhir blok kamus ${name} tidak ditemukan`);
  return new Set(
    [...dictSource.slice(start, end).matchAll(/"([a-zA-Z0-9][a-zA-Z0-9._]*)"\s*:/g)].map((m) => m[1]),
  );
}
const idKeys = dictionaryKeys("ID");
const enKeys = dictionaryKeys("EN");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * `t("kunci")` dan `t(\`kunci\`)`, tetapi bukan `params.get("wh")` — tanpa
 * penjaga di depannya, setiap pemanggilan yang namanya berakhiran "t" ikut
 * tertangkap dan uji ini penuh temuan palsu.
 */
const KEY_CALL = /(?<![.\w])t\(\s*["'`]([a-zA-Z0-9][a-zA-Z0-9._]*)["'`]/g;

const sources = [
  ...walk(join(root, "app")),
  ...walk(join(root, "components")),
  ...walk(join(root, "lib")),
];

/** Kunci yang dipanggil, beserta tempat pertama ia muncul. */
const used = new Map();
for (const file of sources) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(KEY_CALL)) {
    if (used.has(match[1])) continue;
    const line = text.slice(0, match.index).split("\n").length;
    used.set(match[1], `${file.slice(root.length)}:${line}`);
  }
}

test("setiap kunci yang dipakai antarmuka ada di kamus Indonesia", () => {
  const missing = [...used].filter(([key]) => id(key) === key);
  assert.deepEqual(
    missing.map(([key, where]) => `${key} (${where})`),
    [],
    "kunci tanpa terjemahan tampil apa adanya di layar",
  );
});

test("setiap kunci yang dipakai antarmuka ada di kamus Inggris", () => {
  const missing = [...used].filter(([key]) => !enKeys.has(key));
  assert.deepEqual(
    missing.map(([key, where]) => `${key} (${where})`),
    [],
    "kunci ini tampil sebagai teks Indonesia di layar berbahasa Inggris",
  );
});

test("kedua kamus terbaca utuh", () => {
  // Penjaga bagi dua uji di atas: kalau pembacaan bloknya gagal, keduanya akan
  // lulus tanpa memeriksa apa pun.
  assert.ok(idKeys.size > 500, `kamus ID hanya terbaca ${idKeys.size} kunci`);
  assert.ok(enKeys.size > 500, `kamus EN hanya terbaca ${enKeys.size} kunci`);
  const missingEn = [...idKeys].filter((key) => !enKeys.has(key));
  assert.deepEqual(missingEn, [], "kunci ada di kamus Indonesia tetapi tidak di Inggris");
});

test("kunci yang dipakai tidak terbaca sebagai pemanggilan lain", () => {
  // Penjaga uji itu sendiri: pola di atas pernah menangkap `params.get("wh")`
  // dan melaporkan "wh" sebagai kunci yang hilang.
  assert.ok(!used.has("wh"), "pola kunci ikut menangkap params.get()");
  assert.ok(!used.has("limit") && !used.has("offset"), "pola kunci ikut menangkap query string");
  assert.ok(used.size > 500, `hanya ${used.size} kunci terbaca — pola kunci terlalu sempit`);
});

test("menu navigasi punya label, bukan nama kunci", () => {
  // Ketiga kunci ini adalah kegagalan nyata yang memicu uji ini.
  for (const key of ["nav.audit", "nav.guide", "export.warehouseName"]) {
    assert.notEqual(id(key), key, `${key} hilang dari kamus Indonesia`);
    assert.ok(enKeys.has(key), `${key} hilang dari kamus Inggris`);
  }
});
