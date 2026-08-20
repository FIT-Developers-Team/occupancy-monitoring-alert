import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as nativeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../lib/runtime-config.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: "runtime-config.ts",
}).outputText;

const sandboxRoot = mkdtempSync(path.join(os.tmpdir(), "wiom-runtime-config-test-"));
after(() => rmSync(sandboxRoot, { recursive: true, force: true }));

function workspace(name) {
  const root = path.join(sandboxRoot, name);
  mkdirSync(path.join(root, "config"), { recursive: true });
  mkdirSync(path.join(root, "default-config"), { recursive: true });
  return root;
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function loadRuntimeConfig(root, environment = {}) {
  const keys = [
    "DUCKDB_STATE_PATH",
    "WIOM_RUNTIME_CONFIG_DIR",
    "WIOM_LEGACY_CONFIG_DIR",
    "WIOM_BUNDLED_CONFIG_DIR",
  ];
  const previousCwd = process.cwd();
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.chdir(root);
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, environment);
    const moduleRecord = { exports: {} };
    const localRequire = (id) => {
      if (id === "node:fs") return nativeFs;
      if (id === "node:path") return path;
      throw new Error(`Unexpected runtime import in persistence test: ${id}`);
    };
    new Function("require", "module", "exports", compiled)(
      localRequire,
      moduleRecord,
      moduleRecord.exports,
    );
    return moduleRecord.exports;
  } finally {
    process.chdir(previousCwd);
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("first upgrade migrates legacy values and secrets before bundled defaults", () => {
  const root = workspace("legacy-upgrade");
  writeJson(path.join(root, "config", "thresholds.json"), { source: "legacy-admin" });
  writeJson(path.join(root, "config", ".superset-sync.secrets.json"), {
    auth: { cookie_header: "legacy-cookie" },
  });
  writeJson(path.join(root, "default-config", "thresholds.json"), { source: "new-image" });
  writeJson(path.join(root, "default-config", "capacity.json"), { source: "new-default" });

  const runtime = loadRuntimeConfig(root);
  runtime.ensureRuntimeConfigSeeded();

  assert.deepEqual(
    JSON.parse(readFileSync(path.join(root, "db", "runtime-config", "thresholds.json"), "utf8")),
    { source: "legacy-admin" },
  );
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(root, "db", "runtime-config", "capacity.json"), "utf8")),
    { source: "new-default" },
  );
  assert.equal(
    JSON.parse(readFileSync(path.join(root, "db", "runtime-config", ".superset-sync.secrets.json"), "utf8"))
      .auth.cookie_header,
    "legacy-cookie",
  );
});

test("redeploy never overwrites an existing runtime configuration", () => {
  const root = workspace("runtime-wins");
  const legacy = path.join(root, "config", "thresholds.json");
  const bundled = path.join(root, "default-config", "thresholds.json");
  writeJson(legacy, { source: "legacy-v1" });
  writeJson(bundled, { source: "image-v1" });

  loadRuntimeConfig(root).ensureRuntimeConfigSeeded();
  const persisted = path.join(root, "db", "runtime-config", "thresholds.json");
  writeJson(persisted, { source: "saved-in-settings" });
  writeJson(legacy, { source: "legacy-v2" });
  writeJson(bundled, { source: "image-v2" });

  const nextRelease = loadRuntimeConfig(root);
  nextRelease.ensureRuntimeConfigSeeded();
  assert.equal(JSON.parse(readFileSync(persisted, "utf8")).source, "saved-in-settings");
  assert.equal(nextRelease.resolveConfigFile("thresholds.json"), persisted);
});

test("runtime configuration follows DUCKDB_STATE_PATH unless explicitly overridden", () => {
  const root = workspace("state-path");
  const stateDb = path.join(root, "durable-state", "app_state.duckdb");
  const derived = loadRuntimeConfig(root, { DUCKDB_STATE_PATH: stateDb });
  assert.equal(
    derived.RUNTIME_CONFIG_DIR,
    path.join(root, "durable-state", "runtime-config"),
  );

  const explicitDir = path.join(root, "explicit-runtime");
  const explicit = loadRuntimeConfig(root, {
    DUCKDB_STATE_PATH: stateDb,
    WIOM_RUNTIME_CONFIG_DIR: explicitDir,
  });
  assert.equal(explicit.RUNTIME_CONFIG_DIR, explicitDir);
});

test("Linux mount verification rejects container root and accepts /app/db volume", () => {
  const root = workspace("mount-check");
  const runtime = loadRuntimeConfig(root);
  const containerOnly = "36 25 0:32 / / rw,relatime - overlay overlay rw";
  const mounted = [
    containerOnly,
    "40 36 8:1 /docker/volumes/wiom/_data /app/db rw,relatime - ext4 /dev/sda1 rw",
  ].join("\n");
  assert.equal(runtime.persistentMountFromInfo(containerOnly, "/app/db/runtime-config"), false);
  assert.equal(runtime.persistentMountFromInfo(mounted, "/app/db/runtime-config"), true);
});

test("atomic writes leave one complete target and no temporary file", () => {
  const root = workspace("atomic-write");
  const runtime = loadRuntimeConfig(root);
  const target = runtime.runtimeConfigFile("rules.json");
  runtime.writeConfigJsonAtomic(target, { version: 2, enabled: true }, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { version: 2, enabled: true });
  assert.deepEqual(readdirSync(path.dirname(target)).filter((name) => name.endsWith(".tmp")), []);
});

test("deployment assets keep one persistent destination and shared account storage", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
  const accounts = readFileSync(new URL("../lib/account-store.ts", import.meta.url), "utf8");
  const supervisor = readFileSync(new URL("../scripts/start-production.mjs", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../scripts/superset_to_duckdb.py", import.meta.url), "utf8");

  assert.match(dockerfile, /COPY --from=build \/app\/config \.\/default-config/);
  assert.doesNotMatch(dockerfile, /^VOLUME\s/m);
  assert.match(dockerfile, /WIOM_REQUIRE_PERSISTENT_STORAGE=1/);
  assert.doesNotMatch(compose, /\.\/config:\/app\/config/);
  assert.match(accounts, /runtimeConfigFile\("accounts\.json"\)/);
  assert.match(source, /writeConfigJsonAtomic[\s\S]+assertDurableConfigStorage\(\)/);
  assert.match(supervisor, /effectiveConfig = fs\.existsSync\(runtimeConfig\) \? runtimeConfig : configFile/);
  assert.match(worker, /DUCKDB_STATE_PATH[\s\S]+runtime-config/);
});
