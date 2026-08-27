// Kapan sebuah permintaan sinkronisasi manual masih hidup, dan kapan ia mandek.
//
// KEGAGALAN YANG DIJAGA UJI INI
// -----------------------------
// Daemon menghapus `db/.superset-sync-request.json` setelah pass-nya selesai,
// tetapi penghapusan itu dibungkus `except OSError: pass` — dan pada Windows
// berkas yang sedang dibaca memang dapat menolak dihapus. Begitu itu terjadi,
// daemon sudah menyimpan id-nya pada `last_request_id` dan tidak akan pernah
// mengerjakan berkas itu lagi.
//
// Versi sebelumnya di sisi web hanya bertanya "apakah berkas permintaan ada?".
// Jawabannya ya, selamanya — sehingga SETIAP klik "Sync sekarang" berikutnya
// membalas 202 Accepted dengan `reused: true`, antarmuka menampilkan
// "Permintaan yang sudah ada sedang diproses", dan tidak ada satu pun
// sinkronisasi yang benar-benar berjalan. Tidak ada pesan kesalahan di mana
// pun; dasbor hanya diam pada snapshot lama.
//
// Yang membedakan "masih menunggu" dari "yatim" bukan umur berkasnya — sebuah
// pass manual yang sah dapat berjalan bermenit-menit — melainkan status worker.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const compiled = ts.transpileModule(readFileSync(join(root, "lib/superset-sync.ts"), "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;

const require_ = createRequire(import.meta.url);
const moduleRecord = { exports: {} };
new Function("require", "module", "exports", compiled)(
  (id) => {
    // Modul Node dan zod dipakai apa adanya. Dua modul aplikasi
    // (`@/lib/config`, `@/lib/runtime-config`) hanya dipakai oleh fungsi lain
    // di berkas yang sama dan tidak pernah tersentuh dari sini, jadi cukup
    // dikembalikan kosong — kalau suatu saat aturan ini mulai membutuhkannya,
    // uji ini gagal dengan berisik alih-alih menguji tiruan.
    if (id.startsWith("node:") || ["crypto", "fs", "path", "zod"].includes(id)) {
      return require_(id);
    }
    return {};
  },
  moduleRecord,
  moduleRecord.exports,
);
const { pendingRequestState } = moduleRecord.exports;
assert.equal(typeof pendingRequestState, "function", "pendingRequestState tidak diekspor");

const nowIso = () => new Date().toISOString();
const agoIso = (ms) => new Date(Date.now() - ms).toISOString();
const worker = { online: true, ready: true, heartbeat_at: nowIso(), service_started_at: null, error: null };

test("permintaan yang sedang dikerjakan worker tetap dipakai ulang", () => {
  const request = { request_id: "abc", requested_at: agoIso(30 * 60_000) };
  // Berumur setengah jam, tetapi pass-nya memang masih berjalan.
  assert.equal(
    pendingRequestState(request, { state: "running", request_id: "abc", worker }),
    "active",
  );
  assert.equal(
    pendingRequestState(request, { state: "queued", request_id: "abc", worker }),
    "active",
  );
});

test("berkas yang tertinggal setelah pass-nya selesai langsung dianggap mandek", () => {
  // Inti kegagalannya: status sudah menutup permintaan ini, berkasnya masih ada.
  const request = { request_id: "abc", requested_at: agoIso(5_000) };
  assert.equal(
    pendingRequestState(request, { state: "succeeded", request_id: "abc", worker }),
    "stale",
  );
  assert.equal(
    pendingRequestState(request, { state: "failed", request_id: "abc", worker }),
    "stale",
  );
});

test("permintaan yang baru ditulis diberi jeda sebelum disimpulkan yatim", () => {
  // Dua klik beruntun tidak boleh menjadi dua pass.
  const fresh = { request_id: "baru", requested_at: nowIso() };
  assert.equal(
    pendingRequestState(fresh, { state: "succeeded", request_id: "lama", worker }),
    "active",
  );
});

test("permintaan yang tidak pernah tersentuh worker akhirnya dianggap mandek", () => {
  const forgotten = { request_id: "yatim", requested_at: agoIso(10 * 60_000) };
  assert.equal(
    pendingRequestState(forgotten, { state: "succeeded", request_id: "lain", worker }),
    "stale",
  );
  assert.equal(
    pendingRequestState(forgotten, { state: "idle", request_id: null, worker }),
    "stale",
  );
});

test("stempel waktu yang rusak tidak membuat tombol Sync mati selamanya", () => {
  // Berkas yang ditulis tangan atau tersunting sebagian tidak boleh menjadi
  // kondisi terkunci: tanpa waktu yang dapat dibaca, satu-satunya jawaban aman
  // adalah menggantinya.
  for (const requested_at of [undefined, "", "bukan tanggal"]) {
    assert.equal(
      pendingRequestState({ request_id: "x", requested_at }, { state: "idle", worker }),
      "stale",
      `requested_at=${JSON.stringify(requested_at)}`,
    );
  }
});

test("worker yang sibuk pada permintaan LAIN tidak menahan permintaan baru", () => {
  // Pass terjadwal yang sedang berjalan bukan alasan menganggap berkas manual
  // yang sudah lama tertinggal masih hidup.
  const forgotten = { request_id: "yatim", requested_at: agoIso(10 * 60_000) };
  assert.equal(
    pendingRequestState(forgotten, { state: "running", request_id: "terjadwal", worker }),
    "stale",
  );
});
