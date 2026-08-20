import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../app/(dashboard)/heatmap/page.tsx", import.meta.url),
  "utf8",
);

test("Heatmap keeps warehouse cards and no longer renders a duplicate location table", () => {
  assert.match(source, /<HeatmapGrid\b/);
  assert.doesNotMatch(source, /SlocExplorer/);
  assert.doesNotMatch(source, /heat\.tableView/);
  assert.doesNotMatch(source, /storageKey="heatmap"/);
});
