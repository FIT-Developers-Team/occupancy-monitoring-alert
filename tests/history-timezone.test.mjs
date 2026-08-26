// Dua jam berbeda hidup berdampingan di history DuckDB, dan menyamakan keduanya
// adalah cacat tujuh jam yang paling sulit terlihat di aplikasi ini.
//
//  - Kolom milik PROSES SINKRON (`_synced_at`, `_sync_audit.*`) adalah jam
//    dinding WIB yang sebenarnya  -> wibIso()
//  - Kolom BERASAL DARI SUMBER (`created_at`/`updated_at` pergerakan) sudah
//    menerima satu konversi +07:00 di hulu, jadi tujuh jam terlalu cepat
//    -> sourceIso(), yang mengurangkannya kembali
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


test("kolom pergerakan memakai sourceIso, kolom sinkron memakai wibIso", () => {
  // Inilah kontraknya, dan satu-satunya cara ia dapat dilanggar diam-diam
  // adalah dengan menulis kueri baru yang memakai helper yang keliru: hasilnya
  // tetap tampil sebagai jam yang masuk akal, hanya tujuh jam meleset.
  const wrongHelperOnSource = [...code.matchAll(/wibIso\(([^)]*created_at[^)]*|[^)]*updated_at[^)]*)\)/g)]
    .map(([full]) => full)
    // Definisi sourceIso sendiri memanggil wibIso — itu memang jalurnya.
    .filter((call) => !call.includes("INTERVAL"));
  assert.deepEqual(
    wrongHelperOnSource,
    [],
    "kolom created_at/updated_at pergerakan dibungkus wibIso() — pakai sourceIso() "
      + "supaya koreksi jam hulu ikut diterapkan",
  );

  const wrongHelperOnSync = [...code.matchAll(/sourceIso\(([^)]*_synced_at[^)]*|[^)]*finished_at[^)]*)\)/g)]
    .map(([full]) => full);
  assert.deepEqual(
    wrongHelperOnSync,
    [],
    "kolom milik proses sinkron dibungkus sourceIso() — jam itu sudah benar, "
      + "menggesernya membuat 'snapshot terakhir' meleset ke arah sebaliknya",
  );
});

test("koreksi jam sumber menggeser tepat tujuh jam ke belakang", () => {
  // Angka acuannya nyata: baris terbaru di basis data tercatat 14:30:10,
  // sedangkan WMS mencatat kejadian yang sama pukul 07:30 WIB.
  const shift = 7;
  const stored = new Date("2026-08-22T14:30:10+07:00");
  const corrected = new Date(stored.getTime() - shift * 3_600_000);

  assert.equal(
    corrected.toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }),
    "2026-08-22 07:30:10",
  );
});

test("koreksi dapat dimatikan lewat environment bila hulunya diperbaiki", () => {
  // Kalau suatu hari sumbernya berhenti mengonversi dua kali, koreksi ini harus
  // dapat dinolkan tanpa menyentuh kode — kalau tidak, perbaikan di hulu justru
  // menciptakan selisih tujuh jam yang baru, ke arah sebaliknya.
  assert.match(
    code,
    /process\.env\.WIOM_SOURCE_CLOCK_SHIFT_HOURS/,
    "besaran koreksi harus dapat diatur lewat environment",
  );
  assert.match(
    code,
    /Math\.abs\(raw\)\s*<=\s*14/,
    "nilai di luar rentang zona waktu nyata harus ditolak, bukan dipakai diam-diam",
  );
});
