#!/usr/bin/env node
// ===========================================================================
// Data DEMO untuk halaman Pergerakan — TANPA menyentuh data lain.
//
//   node scripts/demo-movements.mjs            → isi movement_events
//   node scripts/demo-movements.mjs --clean    → hapus kembali
//
// MENGAPA TERPISAH DARI scripts/seed.mjs
// --------------------------------------
// `npm run seed` membangun ulang SELURUH database demo. Skrip ini hanya
// menyentuh movement_events, sehingga antarmuka pergerakan dapat dicoba di atas
// database hasil sinkronisasi yang nyata — SLOC, gudang, dan SKU-nya diambil
// dari master yang benar-benar ada — tanpa mengorbankan data stok.
//
// Setiap baris ditandai `invoice_number` berawalan "DEMO-", jadi --clean
// menghapusnya dengan tepat dan baris hasil sinkronisasi asli tidak tersentuh.
// Jalankan --clean sebelum job sync pergerakan pertama supaya angka di layar
// tidak mencampur data contoh dengan data produksi.
// ===========================================================================
import duckdb from "duckdb";

const CLEAN = process.argv.includes("--clean");
const db = new duckdb.Database("db/warehouse_history.duckdb");
const c = db.connect();
const run = (sql, params = []) =>
  new Promise((res, rej) => c.all(sql, ...params, (e, r) => (e ? rej(e) : res(r))));

const ACTIONS = [
  ["Goods Receipt", "+", false, true],
  ["Penerimaan Barang", "+", false, true],
  ["Putaway", "+", true, true],
  ["PUT_AWAY", "+", true, true],
  ["Picking", "-", true, false],
  ["Pengambilan Order", "-", true, false],
  ["Packing", "-", true, false],
  ["Outbound Delivery", "-", true, false],
  ["Internal Transfer", "+", true, true],
  ["Pemindahan Rak", "+", true, true],
  ["Stock Opname Adjustment", "-", true, true],
  ["Return to Vendor", "-", true, false],
  ["Change Status Good to Bad", "-", true, true],
  ["Kegiatan Khusus Gudang", "+", true, true],
];
const OPS = ["Budi Santoso", "Sari Rahayu", "Andi Pratama", "Dewi Lestari",
  "Rizki Ramadhan", "Tono Wijaya", "Maya Kusuma", "Agus Setiawan"];
const STATUSES = ["Available", "Available", "Available", "Bad", "Quarantine"];
const TYPES = ["Consumer Goods", "Fresh", "Frozen Food", "Beverage"];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(7);
const pick = (a) => a[Math.floor(rand() * a.length)];
const q = (s) => (s === null || s === undefined ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
const iso = (d) => d.toISOString().slice(0, 19).replace("T", " ");

async function main() {
  await run("DELETE FROM movement_events WHERE invoice_number LIKE 'DEMO-%'");
  if (CLEAN) {
    const [n] = await run("SELECT count(*)::VARCHAR AS n FROM movement_events");
    console.log("demo rows removed; movement_events now has", n.n, "rows");
    db.close(() => process.exit(0));
    return;
  }

  const slocs = await run(`
    SELECT v.location_id, v.location_name, v.sloc_code
    FROM vw_sloc v WHERE v.active AND v.sloc_code IS NOT NULL
    USING SAMPLE 400 ROWS`);
  const products = await run(`
    SELECT DISTINCT product_id, product_name, sku_number, l1_category
    FROM vw_stock_latest WHERE product_name IS NOT NULL LIMIT 120`);
  if (!slocs.length || !products.length) throw new Error("master/stock kosong");

  const byLocation = new Map();
  for (const s of slocs) {
    if (!byLocation.has(s.location_id)) byLocation.set(s.location_id, []);
    byLocation.get(s.location_id).push(s);
  }

  const now = Date.now();
  const H = 3600_000;
  const rows = [];
  for (let i = 0; i < 1800; i++) {
    const s = pick(slocs);
    const peers = byLocation.get(s.location_id);
    const other = peers[Math.floor(rand() * peers.length)];
    const p = pick(products);
    const [action, sign, hasFrom, hasTo] = pick(ACTIONS);
    // Sebagian besar dalam 7 hari terakhir supaya rentang bawaan berisi.
    const ageHours = rand() < 0.75 ? rand() * 7 * 24 : rand() * 30 * 24;
    const created = new Date(now - ageHours * H);
    const updated = new Date(created.getTime() + (rand() < 0.15 ? rand() * 4 * H : 0));
    const fromStatus = pick(STATUSES);
    rows.push([
      q(iso(new Date(now))), q(iso(created)), q(iso(updated)),
      s.location_id, q(s.location_name),
      q(`DEMO-${String(100000 + Math.floor(rand() * 899999))}`),
      Number(p.product_id), q(p.product_name), q(p.sku_number), q(p.l1_category ?? ""),
      q(pick(TYPES)),
      hasFrom ? q(s.sloc_code) : "NULL",
      hasTo ? q(hasFrom ? other.sloc_code : s.sloc_code) : "NULL",
      q(action), q(sign),
      hasFrom ? q(`PKG-${String(10000 + Math.floor(rand() * 89999))}`) : "NULL",
      hasTo ? q(`PKG-${String(10000 + Math.floor(rand() * 89999))}`) : "NULL",
      q(fromStatus), q(action.includes("Bad") ? "Bad" : fromStatus),
      q(pick(OPS)), Math.round(1 + rand() * 47),
    ]);
  }
  const cols = ["_synced_at", "created_at", "updated_at", "location_id", "location_name",
    "invoice_number", "product_id", "product_name", "sku_number", "l1_category", "product_type",
    "source_sloc", "destination_sloc", "action_raw", "operator_sign",
    "from_package", "to_package", "from_status", "to_status", "operator", "qty"];
  for (let i = 0; i < rows.length; i += 400) {
    const values = rows.slice(i, i + 400).map((r) => `(${r.join(",")})`).join(",");
    await run(`INSERT INTO movement_events (${cols.join(",")}) VALUES ${values}`);
  }
  const [n] = await run("SELECT count(*)::VARCHAR AS n FROM vw_movement");
  console.log("inserted", rows.length, "demo rows; vw_movement now has", n.n);
  db.close(() => process.exit(0));
}

main().catch((e) => { console.error("gagal:", e.message); process.exit(1); });
