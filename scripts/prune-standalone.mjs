// Buang data runtime yang ikut tertelusuri ke dalam `.next/standalone`.
//
// `outputFileTracingExcludes` di next.config.ts hanya menerima path persis di
// lingkungan ini — pola wildcard-nya tidak pernah cocok pada path Windows —
// sementara isi `db/` bertambah setiap kali aplikasi berjalan: berkas DuckDB
// preview, cache read model, dan yang terpenting `db/runtime-config/` yang
// menyimpan kredensial Superset serta konfigurasi hidup. Tak satu pun boleh
// menjadi bagian dari artefak build.
//
// Langkah ini berjalan SETELAH build, sehingga tidak bergantung pada perilaku
// pencocokan pola apa pun: ia hanya menghapus apa yang benar-benar tersalin.
// Aman dijalankan berulang, dan tidak melakukan apa-apa bila tidak ada yang
// tersalin. `db/schema.sql` sengaja dipertahankan — worker sinkronisasi
// membutuhkannya untuk membuat view saat database masih kosong.
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(process.cwd());
const standaloneDb = path.resolve(workspace, ".next", "standalone", "db");

// Penjaga: hanya boleh menyentuh folder db di dalam .next/standalone milik
// workspace ini, tidak pernah folder db sungguhan yang berisi data produksi.
const expected = path.join(workspace, ".next", "standalone", "db");
if (standaloneDb !== expected) {
  throw new Error(`Menolak membersihkan path tak terduga: ${standaloneDb}`);
}

const KEEP = new Set(["schema.sql"]);

let entries;
try {
  entries = await readdir(standaloneDb);
} catch (error) {
  if (error.code === "ENOENT") process.exit(0);
  throw error;
}

const removed = [];
for (const entry of entries) {
  if (KEEP.has(entry)) continue;
  const target = path.join(standaloneDb, entry);
  const info = await stat(target).catch(() => null);
  if (!info) continue;
  await rm(target, { recursive: true, force: true });
  removed.push(entry);
}

if (removed.length) {
  console.info(`[WIOM] Data runtime dibuang dari .next/standalone/db: ${removed.join(", ")}`);
}
