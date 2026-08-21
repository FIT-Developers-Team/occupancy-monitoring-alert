#!/usr/bin/env node
// ===========================================================================
// WIOM v2 — Seed demo selaras struktur Superset asli (deterministik, seed 42).
//   npm run seed      → db/warehouse_history.duckdb + data demo
//   npm run db:init   → skema kosong (mode live)
// Skenario tertanam: BIT & SRG tinggi (BIT ada SLOC over-qty), CBT basis CBM
// (master 1/1 → override), Bad di luar BADSTOCK (R13), Lost (R14),
// qty negatif (R11), phantom/ghost di cycle count.
// ===========================================================================
import duckdb from "duckdb";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DB_PATH = process.env.DUCKDB_HISTORY_PATH || path.join(ROOT, "db", "warehouse_history.duckdb");
const SCHEMA = fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf-8");
const SCHEMA_ONLY = process.argv.includes("--schema-only");

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const pick = (a) => a[Math.floor(rand() * a.length)];
const between = (a, b) => a + rand() * (b - a);
const q = (s) => (s === null || s === undefined) ? "NULL" : `'${String(s).replace(/'/g, "''")}'`;
const iso = (d) => d.toISOString().slice(0, 19).replace("T", " ");
const run = (db, sql) => new Promise((res, rej) => db.all(sql, (e, r) => (e ? rej(e) : res(r))));
async function insert(db, table, cols, rows, batch = 700) {
  for (let i = 0; i < rows.length; i += batch) {
    const v = rows.slice(i, i + batch).map((r) => `(${r.join(",")})`).join(",");
    await run(db, `INSERT INTO ${table} (${cols.join(",")}) VALUES ${v}`);
  }
}

const AMB = "Ambient Room (25C - 30C)";
const CHL = "Chiller (0C - 5C)";
const FRZ = "Frozen Room (-15C -18C)";
const CLR = "Cool Room (15C - 20C)";

// -- WH plan: location_id, caps [maxQty,maxVol], rack_zones + storage ---------
const WH = {
  PGS: { id: 160, name: "PGS - Pegangsaan", lat: -6.1468128, lng: 106.9146491, cap: [200, 100],
    rz: [["PLA1", FRZ], ["PLB1", FRZ], ["CHD1", FRZ], ["CFF1", FRZ], ["CHG1", CHL], ["DCB1", CHL], ["ABB1", AMB]] },
  CBT: { id: 819, name: "CBT - WH Cibitung", lat: -6.3181805, lng: 107.1065821, cap: [1, 1],
    rz: [["SRA1", AMB], ["SRB1", AMB], ["SRC1", AMB], ["MZA1", AMB], ["HRA3", AMB]] },
  STL: { id: 772, name: "STL - Warehouse Sentul", lat: -6.515411, lng: 106.856477, cap: [1, 1],
    rz: [["SRA1", AMB], ["MZA1", AMB], ["HRA1", AMB], ["PLB1", AMB]] },
  SRG: { id: 796, name: "SRG - WH Srengseng", lat: -6.2013185, lng: 106.7557813, cap: [200, 1],
    rz: [["PLA2", FRZ], ["PLC2", FRZ], ["PLD1", FRZ], ["CHA2", FRZ], ["GDC1", FRZ], ["GDF1", CHL]] },
  BGO: { id: 860, name: "BGO - WH Bogor", lat: -6.540537, lng: 106.807858, cap: [20, 2],
    rz: [["CHA1", CHL], ["CRA1", CLR], ["PLA1", AMB]] },
  CBN: { id: 661, name: "CBN - WH Cibinong", lat: -6.507759, lng: 106.837015, cap: [100, 2],
    rz: [["ABA1", AMB], ["ABB1", AMB], ["CHA2", CHL]] },
  BIT: { id: 983, name: "BIT - WH Bitung", lat: -6.253865, lng: 106.554512, cap: [40, 1],
    rz: [["CHA1", FRZ], ["CHC1", FRZ], ["CHD1", FRZ], ["CHE1", FRZ], ["CHH1", FRZ]] },
  STR: { id: 912, name: "WH Sunter Overflow", lat: -6.134659, lng: 106.87748, cap: [200, 100],
    rz: [["CHC1", CHL], ["CHC2", CHL], ["PLD1", CHL]] },
};

// Basis & kapasitas efektif demo — MIRROR config/capacity.json
function effCaps(wh, zone, storage, maxQ, maxV) {
  let basis = "qty", util = 85, capQ = maxQ, capV = maxV;
  if (storage === FRZ) util = 80;
  if (wh === "CBT") { basis = "cbm"; capV = zone === "SRC" ? 2.5 : 3.0; }
  if (wh === "STL") { basis = "cbm"; capV = 2.5; }
  return { basis, capQty: capQ, capCbm: capV * (util / 100) };
}

// -- Katalog produk (subset data asli) ---------------------------------------
// [id, name, sku, category, sku_cbm, pref] pref: A ambient, C chiller, F frozen
const CATALOG = [
  [877, "Indomie Goreng Special Mie Instan", "089686010947", "Kebutuhan Pokok", 0.000768, "A"],
  [875, "Indomie Kuah Soto Mie Mie Instan", "089686010343", "Kebutuhan Pokok", 0.000495, "A"],
  [874, "Indomie Kuah Ayam Bawang Mie Instan", "089686010015", "Kebutuhan Pokok", 0.000495, "A"],
  [876, "Indomie Kuah Kari Ayam Mie Instan", "089686010527", "Kebutuhan Pokok", 0.000768, "A"],
  [1124, "Bango Kecap Manis Botol", "8990121011073", "Bahan Masak & Bumbu", 0.000256, "A"],
  [1627, "Royco Bumbu Kaldu Rasa Ayam", "8999999516208", "Bahan Masak & Bumbu", 0.000468, "A"],
  [5351, "Sasa Santan Kelapa Cair", "8991188943536", "Bahan Masak & Bumbu", 0.0004, "A"],
  [11943, "Rose Brand Santan Kelapa Cair", "8993093665848", "Bahan Masak & Bumbu", 0.000198, "A"],
  [1354, "Sania Minyak Goreng Pouch", "8993496001076", "Kebutuhan Pokok", 0.006, "A"],
  [2764, "Diamond Milk Full Cream Susu UHT", "8999898962540", "Susu & Olahan Susu", 0.00022, "A"],
  [2563, "Frisian Flag Full Cream Susu UHT", "8992753033744", "Susu & Olahan Susu", 0.000224, "A"],
  [47110, "Cimory Zero Sugar Chocolate Susu UHT", "8993200670499", "Susu & Olahan Susu", 0.00028, "A"],
  [47109, "Cimory Zero Sugar Matcha Susu UHT", "8993200670529", "Susu & Olahan Susu", 0.000336, "A"],
  [30591, "Milku Original Susu UHT", "8998866203920", "Susu & Olahan Susu", 0.000325, "A"],
  [5107, "Milk Life Kids Chocolate Susu UHT", "8991999110042", "Susu & Olahan Susu", 0.000135, "A"],
  [46277, "Milk Life Teens Full Cream Susu UHT", "8991999111346", "Susu & Olahan Susu", 0.00024, "A"],
  [19536, "Frisian Flag Kental Manis Pouch", "8992753721597", "Susu & Olahan Susu", 0.0006, "A"],
  [33656, "Ritz Keju Biskuit Sandwich", "7622202217630", "Biskuit", 0.000608, "A"],
  [25857, "Ritz Cokelat Biskuit Sandwich", "7622202007989", "Biskuit", 0.000475, "A"],
  [16885, "Pringles Original", "8886467100260", "Snack", 0.00049, "A"],
  [473, "Hydro Coco Minuman Air Kelapa Original", "8992858527308", "Minuman", 0.00065, "A"],
  [12878, "Teh Botol Sosro Original", "8996006142511", "Minuman", 0.000325, "A"],
  [49548, "Coca-Cola Classic Minuman Soda Can", "8992761111014", "Minuman", 0.00054, "A"],
  [24921, "Kantong Sampah Roll Hitam Size S A Basics", "677521", "Kebutuhan Dapur", 0.000384, "A"],
  [24922, "Kantong Sampah Roll Size M A Basics", "979231", "Kebutuhan Dapur", 0.000375, "A"],
  [24923, "Kantong Sampah Roll Size L A Basics", "865287", "Kebutuhan Dapur", 0.000756, "A"],
  [29824, "Spons Cuci Piring Awan A Basics", "636465", "Peralatan Dapur", 0.000756, "A"],
  [32086, "Kapas Wajah Bertekstur A Basics", "8992964506839", "Perawatan Diri", 0.000396, "A"],
  [44318, "Tisu Basah Antibacterial A Basics", "10000000003614", "Perawatan Rumah", 0.000627, "A"],
  [3360, "Jamur Enoki", "280097", "Sayur Segar", 0.000495, "C"],
  [24120, "Dada Ayam Boneless Astro Farm", "516313", "Ayam & Unggas", 0.000918, "F"],
  [23136, "Paha Ayam Boneless Astro Farm", "694233", "Ayam & Unggas", 0.00119, "F"],
  [3465, "Kanzler Chicken Nugget Original", "8993200664382", "Makanan Beku", 0.00159, "F"],
  [3466, "Kanzler Crispy Chicken Nugget", "8993200664399", "Makanan Beku", 0.00203, "F"],
  [23955, "Glico Wings Frostbite Cookies & Cream Mochi", "8998866820486", "Es Krim", 0.000255, "F"],
  [35450, "Supplies - Sticker Non Kitting Vynil", "00900007443001190", "Internal Warehouse", 0.001, "A"],
  [31719, "Supplies - Thank You Card", "00900007443001017", "Internal Warehouse", 0.001, "A"],
  [25185, "(Per ML) WIP Astro Kitchen - Espresso Base", "320544", "Astro Kitchen - Raw Material Dry", 0.000093, "A"],
  [25219, "(Per Gram) Butterscotch syrup Indesso - AK", "758836", "Astro Kitchen - Raw Material Dry", 0.000003, "A"],
  [45179, "[Per Ml] Malee Coconut Water 1000ML - AC", "737476", "Astro Kitchen - Raw Material Chilled/frozen", 0.0166, "F"],
];
const prod = (id) => CATALOG.find((c) => c[0] === id);
const poolFor = (storage) => {
  const pref = storage === FRZ ? ["F"] : storage === CHL ? ["C", "F"] : ["A"];
  return CATALOG.filter((c) => pref.includes(c[5]) && c[3] !== "Internal Warehouse" && !c[3].startsWith("Astro Kitchen"));
};

// -- Trajektori okupansi (basis kebijakan) per WH, jamLalu → pct --------------
const TRAJ = {
  PGS: [[96, 80], [24, 84], [0, 88]],
  CBT: [[96, 70], [0, 78]],
  STL: [[96, 64], [0, 60]],
  SRG: [[96, 88], [0, 92.5]],
  BGO: [[96, 70], [0, 72]],
  CBN: [[96, 55], [0, 57]],
  BIT: [[96, 93], [24, 95], [0, 96.5]],
  STR: [[96, 40], [0, 46]],
};
function whPct(code, h) {
  const a = TRAJ[code];
  for (let i = 0; i < a.length - 1; i++) {
    const [h1, p1] = a[i], [h2, p2] = a[i + 1];
    if (h <= h1 && h >= h2) return p1 + ((p2 - p1) * (h1 - h)) / (h1 - h2 || 1);
  }
  return a[a.length - 1][1];
}

async function main() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH);
  const db = new duckdb.Database(DB_PATH);
  await run(db, SCHEMA);
  if (SCHEMA_ONLY) {
    console.log(`✔ Skema kosong dibuat: ${DB_PATH} (mode live — isi via sync Superset).`);
    db.close(); return;
  }

  const NOW = new Date();
  const H = 3600_000;
  const synced = q(iso(NOW));

  // -- 1) master_sloc ---------------------------------------------------------
  const slocs = [];
  let sid = 3000000;
  for (const [code, w] of Object.entries(WH)) {
    for (const [rz, storage] of w.rz) {
      for (const aisle of ["01", "02"]) for (const bay of ["01", "02", "03"])
        for (const level of ["L1", "L2", "L3"]) for (const bin of ["01", "02"]) {
          sid++;
          slocs.push({
            sloc_id: sid, wh: code, id: w.id, name: w.name, lat: w.lat, lng: w.lng,
            code: `${code}-${rz}-${aisle}-${bay}-${level}-${bin}`,
            rz, zone: rz.replace(/[0-9]+$/, ""), aisle, bay, level, bin,
            storage, maxQ: w.cap[0], maxV: w.cap[1],
            noise: (rand() - 0.5) * 20,
          });
        }
    }
  }
  // SLOC spesial dari data asli
  sid++;
  slocs.push({ sloc_id: sid, wh: "PGS", id: WH.PGS.id, name: WH.PGS.name, lat: WH.PGS.lat, lng: WH.PGS.lng,
    code: "PGS-STG1-BADSTOCK", rz: "STG1", zone: "STG", aisle: "BA", bay: "ST", level: "CK", bin: "",
    storage: FRZ, maxQ: 5000, maxV: 100, noise: 0, staging: true });
  sid++;
  slocs.push({ sloc_id: sid, wh: "CBN", id: WH.CBN.id, name: WH.CBN.name, lat: WH.CBN.lat, lng: WH.CBN.lng,
    code: "Staging-Antrian-Chiller", rz: "STG1", zone: "STG", aisle: "01", bay: "00", level: "L1", bin: "01",
    storage: CHL, maxQ: 5000, maxV: 60, noise: 0, staging: true });

  await insert(db, "master_sloc",
    ["sloc_id","location_id","location_name","latitude","longitude","sloc_code","area","rack_zone",
     "aisle","bay","level","bin","active","max_quantity","max_volume","storage_handling","_synced_at"],
    slocs.map((s) => [s.sloc_id, s.id, q(s.name), s.lat, s.lng, q(s.code), q(s.wh), q(s.rz),
      q(s.aisle), q(s.bay), q(s.level), q(s.bin), "true", s.maxQ, s.maxV, q(s.storage), synced]));

  // Produk tetap per sloc (1–2 baris)
  for (const s of slocs) {
    const pool = poolFor(s.storage);
    s.p1 = pool[Math.floor(rand() * pool.length)];
    s.p2 = rand() < 0.22 ? pool[Math.floor(rand() * pool.length)] : null;
    if (s.p2 && s.p2[0] === s.p1[0]) s.p2 = null;
    s.split = between(0.5, 0.8);
  }
  // Breach: BIT qty>cap (3 sloc), CBT cbm>cap (2 sloc SRA)
  const breachBIT = slocs.filter((s) => s.wh === "BIT" && s.rz === "CHA1").slice(0, 3).map((s) => s.sloc_id);
  const breachCBT = slocs.filter((s) => s.wh === "CBT" && s.rz === "SRA1").slice(0, 2).map((s) => s.sloc_id);
  const badOutside = slocs.find((s) => s.wh === "CBT" && s.rz === "SRC1"); // R13

  // -- 2) stock_history snapshots --------------------------------------------
  const hours = [];
  for (let h = 24; h >= 0; h--) hours.push(h);
  for (let h = 96; h >= 30; h -= 6) hours.push(h);
  hours.sort((a, b) => b - a);

  const cols = ["_synced_at","location_id","sloc_code","product_id","product_name","sku_number",
    "l1_category","storage_handling","length","width","height","status","stock_qty","sku_cbm","occupied_cbm"];
  const rows = [];
  const lineRow = (ts, s, p, status, qty) => rows.push([
    ts, s.id, q(s.code), p[0], q(p[1]), q(p[2]), q(p[3]), q(s.storage),
    10, 10, 10, q(status), Math.round(qty * 100) / 100, p[4], Math.round(qty * p[4] * 10000) / 10000,
  ]);

  for (const h of hours) {
    const ts = q(iso(new Date(NOW.getTime() - h * H)));
    for (const s of slocs) {
      if (s.staging) continue; // diisi terpisah
      const eff = effCaps(s.wh, s.zone, s.storage, s.maxQ, s.maxV);
      let pct = whPct(s.wh, h) + s.noise + (rand() - 0.5) * 3;
      const isBreach = breachBIT.includes(s.sloc_id) || breachCBT.includes(s.sloc_id);
      if (breachBIT.includes(s.sloc_id)) pct = h <= 24 ? between(105, 115) : between(96, 99);
      if (breachCBT.includes(s.sloc_id)) pct = h <= 24 ? between(104, 112) : between(95, 99);
      pct = Math.max(0, Math.min(pct, isBreach ? 118 : 99)); // hanya sloc breach yang boleh >100
      if (pct < 8) continue; // SLOC kosong

      if (eff.basis === "qty") {
        // total dulu, baru dibagi — cegah pembulatan menembus kapasitas (mis. BIT cap 40)
        let total = Math.max(1, Math.round((pct / 100) * eff.capQty));
        if (!isBreach) total = Math.min(total, Math.max(1, Math.floor(eff.capQty) - 1));
        const q1 = s.p2 ? Math.min(total, Math.max(1, Math.round(total * s.split))) : total;
        lineRow(ts, s, s.p1, "Available", q1);
        if (s.p2 && total - q1 > 0) lineRow(ts, s, s.p2, "Available", total - q1);
      } else {
        const parts = s.p2 ? [[s.p1, s.split], [s.p2, 1 - s.split]] : [[s.p1, 1]];
        for (const [p, frac] of parts) {
          const qty = Math.max(1, Math.round(((pct / 100) * eff.capCbm * frac) / p[4]));
          lineRow(ts, s, p, "Available", qty);
        }
      }
      // R11: satu SLOC STL punya baris qty negatif (6 snapshot terakhir)
      if (s.wh === "STL" && s.rz === "MZA1" && s.aisle === "01" && s.bay === "01"
          && s.level === "L1" && s.bin === "01" && h <= 6) {
        lineRow(ts, s, prod(2563), "Available", -6);
      }
    }
    // BADSTOCK PGS (Bad, sesuai data asli)
    const bs = slocs.find((x) => x.code === "PGS-STG1-BADSTOCK");
    lineRow(ts, bs, prod(25185), "Bad", 4300);
    lineRow(ts, bs, prod(25219), "Bad", 2430);
    lineRow(ts, bs, prod(45179), "Bad", 1800);
    // Staging chiller CBN (Available, sesuai data asli)
    const st = slocs.find((x) => x.code === "Staging-Antrian-Chiller");
    lineRow(ts, st, prod(3360), "Available", 2500 - h * 4);
    // R13: Bad di luar area badstock (12 jam terakhir)
    if (h <= 12) lineRow(ts, badOutside, prod(44318), "Bad", 35);
    // R14: Lost tanpa SLOC
    rows.push([ts, WH.CBT.id, "NULL", 31719, q(prod(31719)[1]), q(prod(31719)[2]),
      q("Internal Warehouse"), q("N/A"), 10, 10, 10, q("Lost"), 2500, 0.001, 2.5]);
    rows.push([ts, WH.PGS.id, "NULL", 35450, q(prod(35450)[1]), q(prod(35450)[2]),
      q("Internal Warehouse"), q("N/A"), 10, 10, 10, q("Lost"), 180, 0.001, 0.18]);
  }
  await insert(db, "stock_history", cols, rows);

  // -- 3) cycle_count (integritas) -------------------------------------------
  const [latestAgg] = [null];
  const sysMap = new Map();
  const agg = await run(db,
    `SELECT sloc_code, sum(stock_qty) qty FROM vw_stock_latest
     WHERE status = 'Available' AND sloc_code IS NOT NULL GROUP BY 1`);
  for (const r of agg) sysMap.set(r.sloc_code, Number(r.qty));
  const cc = [];
  let ccId = 9000;
  const yesterday = new Date(NOW.getTime() - 24 * H).toISOString().slice(0, 10);
  for (const code of ["PGS", "BGO", "BIT"]) {
    const sample = slocs.filter((s) => s.wh === code && !s.staging && rand() < 0.3);
    let phantom = code === "PGS" ? 2 : 1, ghost = code === "BGO" ? 2 : 0;
    for (const s of sample) {
      ccId++;
      const sys = Math.round(sysMap.get(s.code) ?? 0);
      let phys = sys;
      if (sys > 10 && phantom > 0 && rand() < 0.1) { phys = 0; phantom--; }
      else if (sys === 0 && ghost > 0 && rand() < 0.25) { phys = Math.round(between(8, 30)); ghost--; }
      else if (rand() < 0.1 && sys > 5) phys = sys + Math.round(between(-0.12, 0.12) * sys);
      else phys = sys + Math.round(between(-0.02, 0.02) * sys);
      cc.push([q(`CC-${ccId}`), q(yesterday), q(s.code), sys, Math.max(0, phys)]);
    }
  }
  await insert(db, "cycle_count", ["count_id","count_date","sloc_code","system_qty","physical_qty"], cc);

  // -- 4) movement (Recent movements, dataset 705) ---------------------------
  // Aksi sengaja ditulis dengan ejaan yang berbeda-beda — persis seperti data
  // asli, di mana satu kegiatan yang sama muncul sebagai "Putaway", "PUT_AWAY",
  // dan "Penempatan". Demo ini yang membuktikan standardisasi tipe di
  // lib/movements.ts benar-benar bekerja, bukan sekadar meneruskan teks rapi.
  const mv = [];
  const ops = ["Budi Santoso","Sari Rahayu","Andi Pratama","Dewi Lestari",
    "Rizki Ramadhan","Tono Wijaya","Maya Kusuma","Agus Setiawan"];
  const ACTIONS = [
    // [aksi mentah, tanda operator, punya rak asal, punya rak tujuan]
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
  ];
  const STATUSES = ["Available", "Available", "Available", "Bad", "Quarantine"];
  const TYPES = ["Consumer Goods", "Fresh", "Frozen Food", "Beverage"];
  const pool = slocs.filter((x) => !x.staging);
  for (let i = 0; i < 900; i++) {
    const s = pick(pool);
    const other = pick(pool.filter((x) => x.wh === s.wh)) ?? s;
    const p = rand() < 0.7 ? s.p1 : (s.p2 ?? s.p1);
    const [action, sign, hasFrom, hasTo] = pick(ACTIONS);
    const created = new Date(NOW.getTime() - rand() * 30 * 24 * H);
    // Sebagian kecil baris di-update setelah dibuat; itulah yang membedakan
    // patokan waktu kejadian (created_at) dari watermark sinkron (updated_at).
    const updated = new Date(created.getTime() + (rand() < 0.15 ? rand() * 4 * H : 0));
    const fromStatus = pick(STATUSES);
    mv.push([
      synced, q(iso(created)), q(iso(updated)), s.id, q(s.name),
      q(`TRX-${s.wh}-${String(100000 + Math.floor(rand() * 899999))}`),
      p[0], q(p[1]), q(p[2]), q(p[3]), q(pick(TYPES)),
      hasFrom ? q(s.code) : "NULL",
      hasTo ? q(hasFrom ? other.code : s.code) : "NULL",
      q(action), q(sign),
      hasFrom ? q(`PKG-${String(10000 + Math.floor(rand() * 89999))}`) : "NULL",
      hasTo ? q(`PKG-${String(10000 + Math.floor(rand() * 89999))}`) : "NULL",
      q(fromStatus),
      q(action.includes("Bad") ? "Bad" : fromStatus),
      q(pick(ops)),
      Math.round(between(1, 48)),
    ]);
  }
  await insert(db, "movement_events",
    ["_synced_at","created_at","updated_at","location_id","location_name","invoice_number",
     "product_id","product_name","sku_number","l1_category","product_type",
     "source_sloc","destination_sloc","action_raw","operator_sign",
     "from_package","to_package","from_status","to_status","operator","qty"], mv);

  // -- 5) audit sync dummy ----------------------------------------------------
  await insert(db, "_sync_audit",
    ["job","mode","started_at","finished_at","rows_pulled","rows_written","watermark","status","message"],
    [["'sloc_master'","'upsert'", q(iso(new Date(NOW - 6 * 60000))), q(iso(new Date(NOW - 5.6 * 60000))),
      slocs.length, slocs.length, "NULL", "'OK'", "'demo seed'"],
     ["'stock_snapshot'","'snapshot'", q(iso(new Date(NOW - 5 * 60000))), q(iso(new Date(NOW - 4.4 * 60000))),
      rows.length, rows.length, "NULL", "'OK'", "'demo seed'"]]);

  const [c1] = await run(db, "SELECT count(*) n FROM stock_history");
  console.log(`✔ Seed v2: ${DB_PATH}`);
  console.log(`  SLOC ${slocs.length} · baris stok ${c1.n} · snapshot ${hours.length} · cycle count ${cc.length} · movement ${mv.length}`);
  db.close();
}

main().catch((e) => { console.error("Seed gagal:", e); process.exit(1); });
