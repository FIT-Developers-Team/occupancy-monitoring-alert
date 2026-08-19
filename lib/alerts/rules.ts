// Rule registry v2 — semua rule berbasis kondisi stok saat ini (state-based,
// auto-resolve saat pulih). Rule movement menyusul saat tabel movement disinkron.
//
// CATATAN: modul ini BELUM dipakai. lib/alerts/engine.ts mengevaluasi rule-nya
// sendiri; registry ini disiapkan untuk rule berbasis movement. Pemformatan
// angkanya tetap dijaga sama dengan layar agar kelak tidak menjadi satu-satunya
// tempat yang menampilkan kapasitas dengan cara berbeda.
import { queryHistory } from "@/lib/db";
import { getSlocOccupancy } from "@/lib/queries";
import { whMapSQL } from "@/lib/config";
import { fmtCbm, fmtNum } from "@/lib/utils";
import type { Severity } from "@/types";

export interface Violation {
  rule_id: string; rule_name: string; severity: Severity;
  warehouse_code: string; zone: string | null; sloc_code: string | null; sku: string | null;
  title: string; detail: string; dedup_key: string;
}
export interface RuleContext { params: Record<string, unknown>; severity: Severity }
type Evaluator = (ctx: RuleContext) => Promise<Violation[]>;

// ---- R03: Over-capacity SLOC (basis kebijakan) -----------------------------
const r03OverCapacity: Evaluator = async (ctx) => {
  const exclude = new Set((ctx.params.exclude_zones as string[] | undefined) ?? ["STG"]);
  const rows = await getSlocOccupancy();
  return rows.filter((s) => s.pct >= 100 && !exclude.has(s.zone)).map((s) => ({
    rule_id: "R03", rule_name: "Over-Capacity SLOC", severity: ctx.severity,
    warehouse_code: s.wh, zone: s.zone, sloc_code: s.sloc_code, sku: null,
    title: `${s.sloc_code} ${s.pct}% (basis ${s.basis.toUpperCase()})`,
    detail: `Isi ${s.basis === "qty"
      ? `${fmtNum(s.occ_qty)} dari kapasitas ${fmtNum(s.cap_qty)} unit`
      : `${fmtCbm(s.occ_cbm)} dari kapasitas efektif ${fmtCbm(s.cap_cbm)} m³ (max ${s.cap_cbm_nominal} × ${s.utilization_pct}%)`} — relokasi kelebihan ke SLOC kosong terdekat.`,
    dedup_key: `R03:${s.sloc_code}`,
  }));
};

// ---- R11: Stok negatif ------------------------------------------------------
const r11Negative: Evaluator = async (ctx) => {
  const rows = await queryHistory<{ wh: string; sloc: string; name: string; sku: string; qty: number }>(
    `WITH ${whMapSQL()}
     SELECT m.wh, s.sloc_code AS sloc, s.product_name AS name, s.sku_number AS sku, s.stock_qty AS qty
     FROM vw_stock_latest s
     JOIN vw_sloc v ON v.sloc_code = s.sloc_code
     JOIN wh_map m ON m.location_id = v.location_id
     WHERE v.active AND nullif(trim(v.sloc_code), '') IS NOT NULL
       AND nullif(trim(v.zone), '') IS NOT NULL AND s.stock_qty < 0`
  );
  return rows.map((r) => ({
    rule_id: "R11", rule_name: "Stok Negatif", severity: ctx.severity,
    warehouse_code: r.wh, zone: null, sloc_code: r.sloc, sku: r.sku,
    title: `${r.name} = ${r.qty}`,
    detail: `Qty negatif di ${r.sloc} — indikasi transaksi ganda/urutan salah. Investigasi movement & cycle count.`,
    dedup_key: `R11:${r.sloc}:${r.sku}`,
  }));
};

// ---- R13: Bad stock di luar area badstock/staging ---------------------------
const r13BadOutside: Evaluator = async (ctx) => {
  const rawMinQty = Number(ctx.params.min_qty ?? 1);
  const minQty = Number.isFinite(rawMinQty) ? Math.max(0, rawMinQty) : 1;
  const rows = await queryHistory<{ wh: string; zone: string; sloc: string; name: string; sku: string; qty: number }>(
    `WITH ${whMapSQL()}
     SELECT m.wh, v.zone, s.sloc_code AS sloc, s.product_name AS name, s.sku_number AS sku,
            sum(s.stock_qty)::DOUBLE AS qty
     FROM vw_stock_latest s
     JOIN vw_sloc v ON v.sloc_code = s.sloc_code
     JOIN wh_map m ON m.location_id = v.location_id
     WHERE v.active AND nullif(trim(v.sloc_code), '') IS NOT NULL
       AND nullif(trim(v.zone), '') IS NOT NULL AND s.status = 'Bad'
       AND upper(s.sloc_code) NOT LIKE '%BADSTOCK%'
       AND v.zone <> 'STG'
     GROUP BY 1,2,3,4,5
     HAVING sum(s.stock_qty) >= ${minQty}`
  );
  return rows.map((r) => ({
    rule_id: "R13", rule_name: "Bad Stock di Luar Area", severity: ctx.severity,
    warehouse_code: r.wh, zone: r.zone, sloc_code: r.sloc, sku: r.sku,
    title: `${fmtNum(r.qty)} Bad di ${r.sloc}`,
    detail: `${r.name} status Bad berada di rak reguler — pindahkan ke area BADSTOCK agar tidak menghitung okupansi jual & tidak terpicking.`,
    dedup_key: `R13:${r.sloc}:${r.sku}`,
  }));
};

// ---- R14: Stok Lost terdeteksi ---------------------------------------------
const r14Lost: Evaluator = async (ctx) => {
  const rows = await queryHistory<{ location_id: number; wh: string; name: string; sku: string; qty: number }>(
    `WITH ${whMapSQL()}
     SELECT s.location_id, m.wh, s.product_name AS name, s.sku_number AS sku,
            sum(s.stock_qty)::DOUBLE AS qty
     FROM vw_stock_latest s
     JOIN wh_map m ON m.location_id = s.location_id
     WHERE s.status = 'Lost' AND s.stock_qty > 0
     GROUP BY 1, 3, 4`
  );
  return rows.map((r) => ({
    rule_id: "R14", rule_name: "Stok Lost Terdeteksi", severity: ctx.severity,
    warehouse_code: r.wh, zone: null, sloc_code: null, sku: r.sku,
    title: `${fmtNum(r.qty)} Lost — ${r.name}`,
    detail: `Stok berstatus Lost tanpa lokasi. Buka investigasi ILSIM: telusuri movement terakhir, cycle count, dan CCTV area terkait.`,
    dedup_key: `R14:${r.location_id}:${r.sku}`,
  }));
};

export const RULE_EVALUATORS: Record<string, Evaluator> = {
  R03: r03OverCapacity, R11: r11Negative, R13: r13BadOutside, R14: r14Lost,
};
/** Semua rule v2 state-based → auto-resolve saat kondisi pulih. */
export const STATE_RULES = new Set(Object.keys(RULE_EVALUATORS));
