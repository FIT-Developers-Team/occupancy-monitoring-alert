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

/**
 * `fsModule` memungkinkan satu tes mengganti pembacaan /proc/self/mountinfo
 * tanpa menyentuh operasi berkas lain, sehingga mode persistensi dapat diuji
 * pada platform mana pun.
 */
function loadRuntimeConfig(root, environment = {}, fsModule = nativeFs) {
  const keys = [
    "DUCKDB_STATE_PATH",
    "WIOM_RUNTIME_CONFIG_DIR",
    "WIOM_LEGACY_CONFIG_DIR",
    "WIOM_BUNDLED_CONFIG_DIR",
    "WIOM_REQUIRE_PERSISTENT_STORAGE",
    "WIOM_CONFIG_BUNDLE",
  ];
  const previousCwd = process.cwd();
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.chdir(root);
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, environment);
    const moduleRecord = { exports: {} };
    const localRequire = (id) => {
      if (id === "node:fs") return fsModule;
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
  const readyRoute = readFileSync(new URL("../app/api/ready/route.ts", import.meta.url), "utf8");
  const accounts = readFileSync(new URL("../lib/account-store.ts", import.meta.url), "utf8");
  const supervisor = readFileSync(new URL("../scripts/start-production.mjs", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../scripts/superset_to_duckdb.py", import.meta.url), "utf8");

  assert.match(dockerfile, /COPY --from=build \/app\/config \.\/default-config/);
  assert.doesNotMatch(dockerfile, /^VOLUME\s/m);
  assert.match(dockerfile, /WIOM_REQUIRE_PERSISTENT_STORAGE=1/);
  assert.match(dockerfile, /apt-get install[^\n]+curl/);
  assert.match(readyRoute, /PERSISTENT_STORAGE_MISSING/);
  assert.doesNotMatch(compose, /\.\/config:\/app\/config/);
  assert.match(accounts, /runtimeConfigFile\("accounts\.json"\)/);
  assert.match(source, /writeConfigJsonAtomic[\s\S]+assertDurableConfigStorage\(\)/);
  assert.match(supervisor, /effectiveConfig = fs\.existsSync\(runtimeConfig\) \? runtimeConfig : configFile/);
  assert.match(worker, /DUCKDB_STATE_PATH[\s\S]+runtime-config/);
});

test("container healthcheck probes liveness only, never operational readiness", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  const liveRoute = readFileSync(new URL("../app/api/live/route.ts", import.meta.url), "utf8");
  const proxy = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  const supervisor = readFileSync(new URL("../scripts/start-production.mjs", import.meta.url), "utf8");

  // Setiap HEALTHCHECK harus menunjuk /api/live. Menunjuk /api/ready membuat
  // container yang sehat digulung balik hanya karena volume, akun, atau worker
  // Superset belum siap — persis kegagalan deploy 2026-08-20.
  const healthchecks = dockerfile.match(/^HEALTHCHECK[\s\S]*?\n(?:\s+CMD[^\n]*\n)/gm) ?? [];
  assert.equal(healthchecks.length, 2, "kedua stage runtime wajib punya healthcheck");
  for (const check of healthchecks) {
    assert.match(check, /curl --fail-with-body/);
    assert.match(check, /\/api\/live/);
    assert.doesNotMatch(check, /\/api\/(ready|health)\b/);
    assert.doesNotMatch(check, /node -e "fetch\(/);
  }

  // Liveness tidak boleh punya dependensi yang dapat gagal di luar server web.
  assert.doesNotMatch(liveRoute, /@\/lib\/(db|config|queries|runtime-config|superset-sync|account-store)/);
  assert.match(proxy, /"\/api\/live"/);

  // Tick alert tidak boleh digantungkan pada kesegaran snapshot: sinkronisasi
  // yang bermasalah justru saat evaluasi alert paling dibutuhkan.
  assert.match(supervisor, /fetch\(`\$\{base\}\/api\/live`/);
  assert.doesNotMatch(supervisor, /fetch\(`\$\{base\}\/api\/health`/);
});

test("missing persistent storage is reported loudly but only strict mode refuses writes", () => {
  const root = workspace("persistence-modes");
  // Tanpa mountinfo, deteksi mount mengembalikan null di semua platform —
  // yaitu keadaan "tidak dapat dibuktikan persisten" yang dialami deployment.
  const fsWithoutMountInfo = {
    ...nativeFs,
    readFileSync(file, ...rest) {
      if (String(file) === "/proc/self/mountinfo") {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return nativeFs.readFileSync(file, ...rest);
    },
  };

  // Mode dibaca pada saat pemanggilan, bukan saat modul dimuat, jadi variabel
  // lingkungannya diatur di sekitar assertion — bukan lewat loadRuntimeConfig.
  const runtime = loadRuntimeConfig(root, {}, fsWithoutMountInfo);
  const previous = process.env.WIOM_REQUIRE_PERSISTENT_STORAGE;
  try {
    process.env.WIOM_REQUIRE_PERSISTENT_STORAGE = "1";
    assert.equal(runtime.persistenceMode(), "required");
    // Inti perbaikannya: mode bawaan image TIDAK boleh menolak penyimpanan.
    // Menolaknya ikut membatalkan bootstrap akun admin pertama, sehingga
    // container tidak pernah dapat dipakai untuk memperbaiki keadaannya sendiri.
    assert.doesNotThrow(() => runtime.assertDurableConfigStorage());
    const target = runtime.runtimeConfigFile("thresholds.json");
    runtime.writeConfigJsonAtomic(target, { saved: true }, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { saved: true });

    // Tetapi keadaannya tidak disembunyikan: readiness dan banner Pengaturan
    // membaca durable = false dari sini.
    const info = runtime.configStorageInfo();
    assert.equal(info.writable, true);
    assert.equal(info.durable, false);
    assert.equal(info.durabilityRequired, true);
    assert.equal(info.durabilityEnforced, false);

    process.env.WIOM_REQUIRE_PERSISTENT_STORAGE = "strict";
    assert.equal(runtime.persistenceMode(), "strict");
    assert.throws(() => runtime.assertDurableConfigStorage(), /persisten/i);
    assert.equal(runtime.configStorageInfo().durabilityEnforced, true);

    delete process.env.WIOM_REQUIRE_PERSISTENT_STORAGE;
    assert.equal(runtime.persistenceMode(), "off");
    assert.doesNotThrow(() => runtime.assertDurableConfigStorage());
    assert.equal(runtime.configStorageInfo().durable, true);
  } finally {
    if (previous === undefined) delete process.env.WIOM_REQUIRE_PERSISTENT_STORAGE;
    else process.env.WIOM_REQUIRE_PERSISTENT_STORAGE = previous;
  }
});

// ---- Cadangan konfigurasi ---------------------------------------------------
//
// Tanpa volume permanen, satu-satunya cara konfigurasi Pengaturan bertahan
// melewati penggantian container adalah cadangan: berkas yang diunduh admin,
// atau nilai yang disimpan sebagai environment variable deployment.

function withEnv(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("configuration saved as an environment bundle survives a container swap", () => {
  const root = workspace("bundle-env");
  // Container baru: hanya default bawaan image, tidak ada berkas runtime.
  writeJson(path.join(root, "default-config", "thresholds.json"), { source: "image-default" });
  writeJson(path.join(root, "default-config", "capacity.json"), { source: "image-default" });
  const runtime = loadRuntimeConfig(root);

  const bundle = {
    version: 1,
    created_at: "2026-08-20T00:00:00.000Z",
    files: {
      "thresholds.json": { source: "admin-saved", breach: 100 },
      "recipients.json": { source: "admin-saved" },
      "accounts.json": { version: 1, accounts: [] },
    },
  };
  const encoded = Buffer.from(JSON.stringify(bundle), "utf8").toString("base64");

  withEnv({ WIOM_CONFIG_BUNDLE: encoded }, () => runtime.ensureRuntimeConfigSeeded());

  // Nilai admin menang atas default image...
  assert.deepEqual(
    JSON.parse(readFileSync(runtime.runtimeConfigFile("thresholds.json"), "utf8")),
    { source: "admin-saved", breach: 100 },
  );
  // ...termasuk berkas yang tidak punya default image sama sekali.
  assert.deepEqual(
    JSON.parse(readFileSync(runtime.runtimeConfigFile("accounts.json"), "utf8")),
    { version: 1, accounts: [] },
  );
  // Berkas yang tidak ada di cadangan tetap memakai default image.
  assert.deepEqual(
    JSON.parse(readFileSync(runtime.runtimeConfigFile("capacity.json"), "utf8")),
    { source: "image-default" },
  );
});

test("an existing runtime file always outranks the environment bundle", () => {
  const root = workspace("bundle-env-precedence");
  const runtime = loadRuntimeConfig(root);
  runtime.writeConfigJsonAtomic(runtime.runtimeConfigFile("thresholds.json"), { source: "saved-on-volume" });

  const encoded = Buffer.from(JSON.stringify({
    version: 1,
    files: { "thresholds.json": { source: "stale-bundle" } },
  }), "utf8").toString("base64");
  withEnv({ WIOM_CONFIG_BUNDLE: encoded }, () => runtime.ensureRuntimeConfigSeeded());

  assert.deepEqual(
    JSON.parse(readFileSync(runtime.runtimeConfigFile("thresholds.json"), "utf8")),
    { source: "saved-on-volume" },
  );
});

test("a damaged environment bundle is ignored instead of blocking start-up", () => {
  const root = workspace("bundle-env-damaged");
  writeJson(path.join(root, "default-config", "thresholds.json"), { source: "image-default" });
  const runtime = loadRuntimeConfig(root);
  assert.doesNotThrow(() =>
    withEnv({ WIOM_CONFIG_BUNDLE: "not-a-bundle" }, () => runtime.ensureRuntimeConfigSeeded()));
  assert.deepEqual(
    JSON.parse(readFileSync(runtime.runtimeConfigFile("thresholds.json"), "utf8")),
    { source: "image-default" },
  );
});

test("export and restore round-trip the values currently in effect", () => {
  const root = workspace("bundle-roundtrip");
  writeJson(path.join(root, "default-config", "rules.json"), { source: "image-default" });
  const runtime = loadRuntimeConfig(root);
  runtime.writeConfigJsonAtomic(runtime.runtimeConfigFile("thresholds.json"), { breach: 100 });

  const exported = runtime.exportConfigBundle();
  assert.equal(exported.version, 1);
  assert.deepEqual(exported.files["thresholds.json"], { breach: 100 });
  // Yang belum pernah disimpan tetap ikut tercadangkan dari nilai berlaku.
  assert.deepEqual(exported.files["rules.json"], { source: "image-default" });

  runtime.writeConfigJsonAtomic(runtime.runtimeConfigFile("thresholds.json"), { breach: 999 });
  const restored = runtime.importConfigBundle(runtime.encodeConfigBundle(exported));
  assert.ok(restored.includes("thresholds.json"));
  assert.deepEqual(
    JSON.parse(readFileSync(runtime.runtimeConfigFile("thresholds.json"), "utf8")),
    { breach: 100 },
  );
});

test("a restore can only write known configuration filenames", () => {
  const root = workspace("bundle-guard");
  const runtime = loadRuntimeConfig(root);

  // Nama berkas dari cadangan tidak pernah dipercaya sebagai path.
  assert.throws(
    () => runtime.importConfigBundle({
      version: 1,
      files: { "../../escape.json": { evil: true }, "/etc/passwd": { evil: true } },
    }),
    /tidak memuat satu pun berkas konfigurasi yang dikenal/,
  );
  assert.throws(() => runtime.importConfigBundle({ version: 2, files: {} }), /tidak dikenal/);
  assert.throws(
    () => runtime.importConfigBundle({ version: 1, files: { "rules.json": "bukan-objek" } }),
    /tidak valid/,
  );
  // Bukti yang sebenarnya: cadangan yang ditolak tidak menulis apa pun, di
  // dalam folder runtime maupun di luarnya.
  const runtimeDir = path.dirname(runtime.runtimeConfigFile("rules.json"));
  assert.deepEqual(nativeFs.existsSync(runtimeDir) ? readdirSync(runtimeDir) : [], []);
  assert.equal(nativeFs.existsSync(path.join(sandboxRoot, "escape.json")), false);
  assert.equal(nativeFs.existsSync(path.join(root, "escape.json")), false);
});
