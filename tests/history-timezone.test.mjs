// Setiap timestamp naif di history DuckDB adalah JAM DINDING WIB, bukan UTC.
//
// Kekeliruan ini tidak pernah terlihat di mesin pengembang yang jamnya kebetulan
// WIB: `new Date("2026-08-22 14:24:59")` diurai sebagai waktu lokal, dan di
// laptop WIB hasilnya kebetulan benar. Begitu dideploy ke kontainer yang jamnya
// UTC — dan itulah yang berjalan di produksi — angka yang sama terbaca tujuh jam
// lebih lambat. Grafik tren, "snapshot terakhir" di halaman Integritas dan
// Pengaturan, serta pemeriksaan umur data di /api/health semuanya pernah salah
// sebanyak itu.
//
// Uji ini menjaga dua kontraknya sekaligus, dan sengaja membaca TEKS SUMBER:
// yang harus dijamin bukan hasil satu pemanggilan, melainkan bahwa tidak ada
// kueri baru yang lolos tanpa mengikuti aturannya.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../lib/queries.ts", import.meta.url), "utf8");

/** Baris komentar dibuang supaya contoh di dalam dokumentasi tidak ikut diuji. */
const code = source
  .split("\n")
  .filter((line) => !/^\s*(\*|\/\/|--)/.test(line))
  .join("\n");

test("timestamp riwayat tidak pernah dikirim tanpa offset WIB", () => {
  // `::VARCHAR` pada kolom waktu adalah bentuk yang justru terlihat benar tetapi
  // menghasilkan string tanpa zona — persis cacat yang diperbaiki.
  const naked = [...code.matchAll(/(\w+(?:\.\w+)?)\s*::VARCHAR\s+AS\s+(\w+)/gi)]
    .filter(([, column, alias]) =>
      /(_at|_date|^t$|\bt\b)/i.test(column) || /(_at|_date|^t$|last|finished)/i.test(alias));

  assert.deepEqual(
    naked.map(([full]) => full),
    [],
    "kolom waktu dicor ke VARCHAR tanpa offset — bungkus dengan wibIso() supaya "
      + "peramban dan kontainer UTC membacanya sebagai instan yang sama",
  );
});

test("jendela waktu riwayat tidak memakai now() DuckDB", () => {
  // now() mengembalikan UTC. Membandingkannya dengan kolom berjam WIB menggeser
  // jendelanya tujuh jam — "24 jam terakhir" diam-diam menjadi 17 atau 31 jam.
  const offenders = [...code.matchAll(/(\w+(?:\.\w+)?)\s*>=\s*now\(\)\s*-\s*INTERVAL/gi)]
    .map(([, column]) => column)
    .filter((column) => /_synced_at|created_at|updated_at|count_date/i.test(column));

  assert.deepEqual(
    offenders,
    [],
    "kolom riwayat dibandingkan dengan now() DuckDB (UTC) — pakai wibCutoff() "
      + "yang menghitung batasnya sebagai jam dinding WIB",
  );
});

test("wibIso menghasilkan instan yang sama di zona waktu proses mana pun", () => {
  // Bentuk yang dihasilkan wibIso(): jam dinding apa adanya + offset eksplisit.
  // Instannya tetap sama dijalankan di mana pun, dan itulah seluruh gunanya.
  assert.equal(
    new Date("2026-08-22T14:30:38+07:00").toISOString(),
    "2026-08-22T07:30:38.000Z",
  );

  // Bentuk lama — tanpa offset — diurai sebagai waktu LOKAL proses. Dibuktikan
  // tanpa bergantung pada TZ mesin penguji: hasilnya selalu identik dengan Date
  // yang dibangun dari komponen waktu lokal. Di laptop WIB keduanya kebetulan
  // menunjuk instan yang benar; di kontainer UTC keduanya sama-sama meleset
  // tujuh jam, dan tidak ada yang berubah di layar untuk menandainya.
  assert.equal(
    new Date("2026-08-22 14:30:38").getTime(),
    new Date(2026, 7, 22, 14, 30, 38).getTime(),
    "string tanpa offset selalu mengikuti TZ proses — itulah sumber selisihnya",
  );
});

test("helper zona waktu tersedia untuk seluruh kueri, bukan hanya pergerakan", () => {
  // Sebelumnya wibIso/wibWallClock hidup di dalam blok pergerakan di bagian
  // bawah berkas, sehingga kueri tren dan kesehatan sinkron tidak memakainya.
  const helperAt = code.indexOf("const wibIso");
  const flowAt = code.indexOf("async function loadMovementFlowSeries");
  const syncAt = code.indexOf("export async function getSyncHealth");

  assert.ok(helperAt > 0, "wibIso harus ada");
  assert.ok(flowAt > 0, "deret aliran pergerakan harus ada");
  assert.ok(helperAt < flowAt, "wibIso harus terdefinisi sebelum kueri deret aliran");
  assert.ok(helperAt < syncAt, "wibIso harus terdefinisi sebelum getSyncHealth");
});
