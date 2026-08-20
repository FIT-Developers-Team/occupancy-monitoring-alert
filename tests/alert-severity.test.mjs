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

const {
  classifyOverflow,
  isZoneCapacityRecovered,
  overflowReason,
  shouldKeepSlocCapacityAlertOpen,
  shouldTriggerSlocCapacityAlert,
  shouldTriggerZoneCapacityAlert,
} = moduleRecord.exports;

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
  assert.match(overflowReason(verdict), /CBM melewati/);
  assert.match(overflowReason(verdict), /Qty tepat/);
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

test("zone trigger and hysteresis recovery use the same two-basis contract", () => {
  const exact = classify(100, 100);
  assert.equal(shouldTriggerZoneCapacityAlert(exact, 80, 100), true);
  assert.equal(isZoneCapacityRecovered(exact, 80, 100, 3), false);

  const clear = classify(99.9, 99.9);
  assert.equal(shouldTriggerZoneCapacityAlert(clear, 99, 100), false);
  assert.equal(isZoneCapacityRecovered(clear, 98, 100, 3), false);
  assert.equal(isZoneCapacityRecovered(clear, 96.9, 100, 3), true);
});

test("SLOC creation prioritises dual max while an existing alert stays open at max", () => {
  const dualExact = classify(100, 100);
  const singleExact = classify(100, 80);
  const recovered = classify(99.9, 80);

  assert.equal(shouldTriggerSlocCapacityAlert(dualExact, 110), true);
  assert.equal(shouldTriggerSlocCapacityAlert(singleExact, 110), false);
  assert.equal(shouldKeepSlocCapacityAlertOpen(singleExact, 110), true);
  assert.equal(shouldKeepSlocCapacityAlertOpen(recovered, 110), false);
});
