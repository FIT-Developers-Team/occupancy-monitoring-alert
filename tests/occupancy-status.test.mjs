// BREACH ADALAH SIFAT LOKASI, BUKAN SIFAT SATU BASIS.
//
// Sebuah lokasi hanya Breach ketika Qty DAN CBM sama-sama MELEWATI kapasitas
// maksimum. Dua regresi dijaga di sini, dan keduanya nyata:
//
//  1. Satu basis yang lewat sendirian pernah cukup untuk menandai Breach. Pada
//     basis data ini itu berarti 29.012 lokasi merah, padahal 18.378 di
//     antaranya hanya lewat pada Qty dan 3.554 hanya pada CBM — kondisi yang
//     jauh lebih sering berarti angka master salah daripada rak penuh. Dengan
//     aturan dua basis, angkanya menjadi 7.080.
//  2. Isi yang PERSIS sama dengan kapasitas maksimum pernah tampil "Breach" di
//     heatmap sementara mesin alert menilainya Critical.
//
// Tangga di layar dan tangga severity alert harus sepakat pada titik yang
// paling sering dilihat orang: batas kapasitas.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function compile(relative, fileName) {
  return ts.transpileModule(readFileSync(new URL(relative, import.meta.url), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName,
  }).outputText;
}

function loadModule(compiled, requireImpl) {
  const record = { exports: {} };
  new Function("require", "module", "exports", compiled)(requireImpl, record, record.exports);
  return record.exports;
}

const DEFAULT_THRESHOLDS = Object.freeze({
  monitor: 70, warning: 85, critical: 95, breach: 100, hysteresis_buffer: 3,
});
let thresholds = DEFAULT_THRESHOLDS;

const configStub = {
  thresholdsFor: () => thresholds,
  getThresholds: () => ({
    overflow_severity: {
      over_pct: 100,
      single_basis: "CRITICAL",
      dual_basis: "EMERGENCY",
      dual_at_capacity: "CRITICAL",
      single_at_capacity: "HIGH",
      single_measurable: "CRITICAL",
      threshold_only: "HIGH",
    },
  }),
};

// Modul severity dimuat apa adanya, bukan ditiru: toleransi batas kapasitas
// harus benar-benar satu definisi yang dipakai kedua tangga.
const severity = loadModule(compile("../lib/alerts/severity.ts", "severity.ts"), (id) => {
  if (id === "@/lib/config") return configStub;
  throw new Error(`Unexpected import in occupancy status test: ${id}`);
});
const occupancy = loadModule(compile("../lib/occupancy.ts", "occupancy.ts"), (id) => {
  if (id === "@/lib/config") return configStub;
  if (id === "@/lib/alerts/severity") return severity;
  throw new Error(`Unexpected import in occupancy status test: ${id}`);
});

const { rungFor, isDualBreach, occupancyStatuses, statusForRow, ladderLevel } = occupancy;

/** Pintasan: status pada basis kebijakan untuk sebuah bacaan dua basis. */
const statusOf = (qty, cbm, wh = "CBT", policy = Math.max(qty ?? 0, cbm ?? 0)) =>
  statusForRow({ pct_qty: qty, pct_cbm: cbm }, policy, wh);
const { classifyOverflow } = severity;

test("Breach menuntut KEDUA basis melewati kapasitas", () => {
  // Inilah aturannya, dinyatakan langsung.
  assert.equal(statusOf(100.1, 100.1), "BREACH");

  // Satu basis lewat sendirian berhenti di Kritis — apa pun besarnya. Lokasi
  // 5.000% menurut CBM dengan Qty santai hampir selalu berarti max_volume yang
  // salah, bukan rak yang penuh.
  assert.equal(statusOf(100.1, 40), "CRITICAL");
  assert.equal(statusOf(40, 5000), "CRITICAL");
});

test("mencapai batas bukan melewatinya", () => {
  // Qty 12/12 dan CBM 0,034/0,034 — keduanya persis 100%: penuh, belum lewat.
  assert.equal(statusOf(100, 100), "CRITICAL");
  assert.equal(statusOf(100.1, 100.1), "BREACH");
  assert.equal(statusOf(99.9, 99.9), "CRITICAL");
  assert.equal(statusOf(94.9, 94.9), "WARNING");
  assert.equal(statusOf(84.9, 84.9), "MONITOR");
  assert.equal(statusOf(69.9, 69.9), "NORMAL");
});

test("status mengikuti angka satu desimal yang tampil di sebelahnya", () => {
  // 100,04% tampil "100,0%" -> masih Critical; 100,06% tampil "100,1%" -> Breach.
  assert.equal(statusOf(100.04, 100.04), "CRITICAL");
  assert.equal(statusOf(100.06, 100.06), "BREACH");
  assert.equal(statusOf(100.000000000001, 100.000000000001), "CRITICAL");
});

test("lokasi tanpa dua kapasitas sahih tidak pernah Breach", () => {
  // Syarat "keduanya lewat" tidak dapat dibuktikan, dan menghukum lubang di
  // data master dengan tanda merah tertinggi hanya memindahkan masalahnya.
  assert.equal(statusOf(5000, null), "CRITICAL");
  assert.equal(statusOf(null, 5000), "CRITICAL");
  assert.equal(isDualBreach({ pct_qty: 5000, pct_cbm: null }, "CBT"), false);
});

test("saat lokasi Breach, SETIAP basis tampilan menyebutnya Breach", () => {
  // "Breach" harus berarti satu hal yang sama di setiap layar; kalau lencananya
  // berubah tergantung basis mana yang sedang dipilih, orang berhenti
  // mempercayainya.
  const set = occupancyStatuses({ pct_qty: 120, pct_cbm: 110 }, 120, "CBT");
  assert.deepEqual(set, { status: "BREACH", status_qty: "BREACH", status_cbm: "BREACH" });

  // Sebaliknya, basis yang lewat sendirian tidak menaikkan lencana mana pun.
  const single = occupancyStatuses({ pct_qty: 120, pct_cbm: 50 }, 120, "CBT");
  assert.deepEqual(single, { status: "CRITICAL", status_qty: "CRITICAL", status_cbm: "NORMAL" });
});

test("rungFor tidak pernah mengembalikan BREACH", () => {
  // Tangga satu-basis sengaja berhenti di Kritis: keputusan Breach memerlukan
  // dua angka dan karenanya tidak dapat diambil dari satu.
  for (const pct of [100, 100.1, 500, 5000]) {
    assert.equal(rungFor(pct, "CBT"), "CRITICAL");
  }
});

test("tangga status dan severity alert sepakat di batas kapasitas", () => {
  const atMax = classifyOverflow({ pct_qty: 100, pct_cbm: 100 });
  assert.equal(atMax.severity, "CRITICAL");
  assert.equal(statusOf(100, 100), "CRITICAL");

  const overMax = classifyOverflow({ pct_qty: 100.1, pct_cbm: 100.1 });
  assert.equal(overMax.severity, "EMERGENCY");
  assert.equal(statusOf(100.1, 100.1), "BREACH");

  // Satu basis lewat: severity Critical DAN status Critical — sepakat.
  const single = classifyOverflow({ pct_qty: 100.1, pct_cbm: 50 });
  assert.equal(single.severity, "CRITICAL");
  assert.equal(statusOf(100.1, 50), "CRITICAL");
});

test("override ambang per gudang tetap memakai aturan dua basis", () => {
  thresholds = { monitor: 70, warning: 82, critical: 92, breach: 95, hysteresis_buffer: 4 };
  try {
    assert.equal(statusOf(95, 95, "PGS"), "CRITICAL");
    assert.equal(statusOf(95.1, 95.1, "PGS"), "BREACH");
    assert.equal(statusOf(95.1, 90, "PGS"), "CRITICAL");
    assert.equal(statusOf(91.9, 91.9, "PGS"), "WARNING");
  } finally {
    thresholds = DEFAULT_THRESHOLDS;
  }
});

test("ladderLevel tetap berurutan dan konsisten dengan statusForRow", () => {
  const level = (qty, cbm) => ladderLevel({ pct_qty: qty, pct_cbm: cbm }, Math.max(qty, cbm), "CBT");
  assert.equal(level(100, 100), 3);
  assert.equal(level(100.1, 100.1), 4);
  assert.equal(level(100.1, 50), 3);
  assert.ok(level(100.1, 100.1) > level(100, 100));
});

test("tangga SQL memakai aturan dua basis yang sama", () => {
  // Tabel kepadatan dan ekspor Excel memakai ekspresi SQL, bukan occupancyStatuses().
  // Satu tanda yang berbeda membuat lokasi yang sama tampil "Breach" di satu
  // halaman dan "Kritis" di halaman lain.
  const queries = readFileSync(new URL("../lib/queries.ts", import.meta.url), "utf8");
  const ladder = queries.match(/function statusLadderSQL[\s\S]*?ELSE 'NORMAL' END`;/);
  assert.ok(ladder, "statusLadderSQL harus tetap ada");

  // Breach hanya bila KEDUA basis lewat.
  assert.match(ladder[0], /\$\{over\(qtyExpr\)\} AND \$\{over\(cbmExpr\)\} THEN 'BREACH'/);
  // Melewati, bukan menyentuh.
  assert.match(ladder[0], /> \$\{t\.breach \+ CAPACITY_MATCH_TOLERANCE_PCT\}/);
  assert.doesNotMatch(ladder[0], />= \$\{t\.breach\} THEN 'BREACH'/);
  assert.match(ladder[0], />= \$\{t\.critical\} THEN 'CRITICAL'/);

  // Mesin alert memakai predikat yang sama, bukan OR dua tangga terpisah.
  assert.match(queries, /function dualBreachSQL/);
  // Mesin alert menyaring lewat predikat dua basis, bukan dua tangga ber-OR.
  assert.match(queries, /dualBreachSQL\("sc\.wh", "sc\.pct_qty", "sc\.pct_cbm"\)/);
  assert.doesNotMatch(queries, /OR \$\{statusLadderSQL/);
});
