import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../lib/alerts/severity.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: "severity.ts",
}).outputText;

const BASE_POLICY = Object.freeze({
  over_pct: 100,
  single_basis: "CRITICAL",
  dual_basis: "EMERGENCY",
  dual_at_capacity: "CRITICAL",
  single_at_capacity: "HIGH",
  single_measurable: "CRITICAL",
  threshold_only: "HIGH",
});

let activePolicy = BASE_POLICY;
const moduleRecord = { exports: {} };
const localRequire = (id) => {
  if (id === "@/lib/config") {
    return { getThresholds: () => ({ overflow_severity: activePolicy }) };
  }
  throw new Error(`Unexpected runtime import in severity test: ${id}`);
};
new Function("require", "module", "exports", compiled)(
  localRequire,
  moduleRecord,
  moduleRecord.exports,
);

const { classifyOverflow, hasExceededBothBases } = moduleRecord.exports;

function classify(pct_qty, pct_cbm, policy = {}) {
  activePolicy = { ...BASE_POLICY, ...policy };
  return classifyOverflow({ pct_qty, pct_cbm });
}

test("Qty and CBM exactly at configured max are always Critical", () => {
  const verdict = classify(100, 100, {
    over_pct: 140,
    dual_at_capacity: "INFO",
  });
  assert.equal(verdict.kind, "dual_at_capacity");
  assert.equal(verdict.severity, "CRITICAL");
  assert.equal(verdict.overPct, 100);
  assert.deepEqual(verdict.at_capacity, ["qty", "cbm"]);
  assert.deepEqual(verdict.exceeded, []);
});

test("capacity boundary matches the one-decimal value shown in the dashboard", () => {
  assert.equal(classify(99.9, 99.9).kind, "none");
  assert.equal(classify(100, 80).kind, "single_at_capacity");
  assert.equal(classify(100.00000000001, 80).kind, "single_at_capacity");
  assert.equal(classify(100.1, 80).kind, "single_over");
});

test("single-basis states keep their configured severity ladder", () => {
  assert.equal(classify(100, 80).severity, "HIGH");
  assert.equal(classify(100.1, 80).severity, "CRITICAL");
  assert.equal(classify(100.1, null).kind, "single_measurable_over");
  assert.equal(classify(100.1, null).severity, "CRITICAL");
  assert.equal(classify(100, null).kind, "single_measurable_at_capacity");
  assert.equal(classify(100, null).severity, "HIGH");
});

test("mixed dual-basis state is Breach without claiming both bases are over", () => {
  const verdict = classify(100, 100.1);
  assert.equal(verdict.kind, "dual_mixed");
  assert.equal(verdict.severity, "EMERGENCY");
  assert.deepEqual(verdict.at_capacity, ["qty"]);
  assert.deepEqual(verdict.exceeded, ["cbm"]);
});

test("both bases over max remain Breach and missing bases remain explicit", () => {
  const dual = classify(100.1, 120);
  assert.equal(dual.kind, "dual_over");
  assert.equal(dual.severity, "EMERGENCY");
  assert.deepEqual(dual.exceeded, ["qty", "cbm"]);

  const unavailable = classify(null, null);
  assert.equal(unavailable.kind, "none");
  assert.equal(unavailable.severity, "HIGH");
  assert.deepEqual(unavailable.measurable, []);
});

// Kontrak pemicu: alert hanya dibuat ketika Qty DAN CBM sama-sama MELEWATI
// kapasitas. Dua syarat yang menyaring hal berbeda — melewati (bukan menyentuh)
// dan keduanya (bukan salah satu) — dan keduanya diuji di sini.
test("alert menuntut KEDUA basis melewati kapasitas", () => {
  assert.equal(hasExceededBothBases(classify(100.1, 120)), true, "dua basis lewat = alert");

  // Satu basis lewat sendirian bukan alert: jauh lebih sering berarti angka
  // master basis itu yang salah daripada lokasi yang benar-benar penuh.
  assert.equal(hasExceededBothBases(classify(100.1, 80)), false, "hanya Qty lewat");
  assert.equal(hasExceededBothBases(classify(80, 5000)), false, "hanya CBM lewat, sebesar apa pun");
  assert.equal(hasExceededBothBases(classify(100, 100.1)), false, "satu lewat, satu pas di max");
});

test("mencapai batas bukan melewatinya", () => {
  // Lokasi bisa duduk berminggu-minggu tepat di angka maksimum tanpa satu pun
  // barang yang tidak punya tempat; memberitakannya membuat papan alert menjadi
  // daftar yang tidak pernah bisa dikosongkan.
  assert.equal(hasExceededBothBases(classify(100, 100)), false, "keduanya tepat di max");
  assert.equal(hasExceededBothBases(classify(99.9, 99.9)), false, "di dalam kapasitas");
});

// Toleransi pembulatan berlaku sama untuk pemicunya: yang tampil "100,0%" di
// layar tidak boleh diam-diam menjadi alert hanya karena angka mentahnya
// 100,04%.
test("pemicu memakai toleransi yang sama dengan angka di layar", () => {
  assert.equal(hasExceededBothBases(classify(100.04, 100.04)), false);
  assert.equal(hasExceededBothBases(classify(100.06, 100.06)), true);
});

test("satu basis tak terukur berarti tidak akan pernah beralert", () => {
  // "Keduanya lewat" tidak dapat dibuktikan ketika hanya satu kapasitas sahih.
  assert.equal(hasExceededBothBases(classify(5000, null)), false);
  assert.equal(hasExceededBothBases(classify(null, 5000)), false);
});
