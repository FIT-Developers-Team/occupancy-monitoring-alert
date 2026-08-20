// Tangga status okupansi (yang tampil sebagai badge di heatmap, kartu zona, dan
// tabel kepadatan) harus sepakat dengan tangga severity alert pada satu titik
// yang paling sering dilihat orang: batas kapasitas.
//
// Regresi yang dijaga di sini nyata: lokasi CBT-MZA1-01-02-L1-04 dengan Qty
// 12/12 dan CBM 0,034/0,034 tampil "Breach" di popup heatmap, sementara mesin
// alert menilai kondisi yang sama persis sebagai Critical.
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

const { statusFor, ladderLevel } = occupancy;
const { classifyOverflow } = severity;

test("a location exactly at max reads Critical, not Breach", () => {
  // Qty 12/12 dan CBM 0,034/0,034 — keduanya persis 100%.
  assert.equal(statusFor(100, "CBT"), "CRITICAL");
  assert.equal(statusFor(100.1, "CBT"), "BREACH");
  assert.equal(statusFor(99.9, "CBT"), "CRITICAL");
  assert.equal(statusFor(94.9, "CBT"), "WARNING");
  assert.equal(statusFor(84.9, "CBT"), "MONITOR");
  assert.equal(statusFor(69.9, "CBT"), "NORMAL");
});

test("status matches the one-decimal percentage shown beside it", () => {
  // 100,04% tampil "100,0%" -> masih Critical; 100,06% tampil "100,1%" -> Breach.
  assert.equal(statusFor(100.04, "CBT"), "CRITICAL");
  assert.equal(statusFor(100.06, "CBT"), "BREACH");
  assert.equal(statusFor(100.000000000001, "CBT"), "CRITICAL");
});

test("status ladder and alert severity agree at the capacity boundary", () => {
  const atMax = classifyOverflow({ pct_qty: 100, pct_cbm: 100 });
  assert.equal(atMax.severity, "CRITICAL");
  assert.equal(statusFor(100, "CBT"), "CRITICAL");

  const overMax = classifyOverflow({ pct_qty: 100.1, pct_cbm: 100.1 });
  assert.equal(overMax.severity, "EMERGENCY");
  assert.equal(statusFor(100.1, "CBT"), "BREACH");
});

test("per-warehouse breach overrides keep the same reach-versus-exceed rule", () => {
  thresholds = { monitor: 70, warning: 82, critical: 92, breach: 95, hysteresis_buffer: 4 };
  try {
    assert.equal(statusFor(95, "PGS"), "CRITICAL");
    assert.equal(statusFor(95.1, "PGS"), "BREACH");
    assert.equal(statusFor(91.9, "PGS"), "WARNING");
  } finally {
    thresholds = DEFAULT_THRESHOLDS;
  }
});

test("ladderLevel stays ordered and consistent with statusFor", () => {
  assert.equal(ladderLevel(100, "CBT"), 3);
  assert.equal(ladderLevel(100.1, "CBT"), 4);
  assert.ok(ladderLevel(100.1, "CBT") > ladderLevel(100, "CBT"));
});

test("the SQL ladder mirrors statusFor instead of drifting from it", () => {
  // Tabel kepadatan dan ekspor Excel memakai ekspresi SQL, bukan statusFor().
  // Satu tanda yang berbeda membuat lokasi yang sama tampil "Breach" di satu
  // halaman dan "Kritis" di halaman lain.
  const queries = readFileSync(new URL("../lib/queries.ts", import.meta.url), "utf8");
  const ladder = queries.match(/function statusLadderSQL[\s\S]*?ELSE 'NORMAL' END`;/);
  assert.ok(ladder, "statusLadderSQL harus tetap ada");
  assert.match(ladder[0], /> \$\{t\.breach \+ CAPACITY_MATCH_TOLERANCE_PCT\} THEN 'BREACH'/);
  assert.doesNotMatch(ladder[0], />= \$\{t\.breach\} THEN 'BREACH'/);
  assert.match(ladder[0], />= \$\{t\.critical\} THEN 'CRITICAL'/);
});
