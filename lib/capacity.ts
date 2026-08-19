// Resolver kapasitas & basis okupansi (Qty/CBM) — precedence berurutan:
// defaults -> rules (aturan di bawah menimpa yang di atas, yang cocok scope-nya).
import { getCapacity } from "@/lib/config";
import type { Basis } from "@/types";

export interface SlocScope {
  wh: string;
  zone: string;       // SRA
  rack_zone: string;  // SRA1
  aisle: string;
  bay: string;
  level: string;
  bin: string;
  storage: string;
  max_quantity: number;
  max_volume: number;
}

export interface ResolvedCap {
  basis: Basis;
  cap_qty: number;
  cap_cbm: number;    // efektif (× utilisasi)
  /**
   * Angka max_cbm persis seperti yang tertulis di konfigurasi — sebelum faktor
   * utilisasi volume.
   *
   * Dipisahkan karena inilah satu-satunya nilai yang dapat dicocokkan admin
   * dengan apa yang ia ketik di Pengaturan. Menampilkan hanya kapasitas efektif
   * membuat "max CBM 0,0336" terbaca sebagai "0,029" di layar, dan itu tampak
   * seperti konfigurasi tidak diterapkan padahal justru sedang diterapkan.
   */
  cap_cbm_nominal: number;
  /** Kapasitas qty tidak diturunkan: utilisasi hanya berlaku untuk volume. */
  cap_qty_nominal: number;
  utilization_pct: number;
  qty_valid: boolean; // master max_quantity > 1 ATAU ada override — nilai 1 = sentinel per-slot
  cbm_valid: boolean;
}

type RuleScope = {
  wh?: string; zone?: string; rack_zone?: string; aisle?: string; bay?: string;
  level?: string; bin?: string; storage?: string; l1_category?: string;
};

function locationScopeMatches(s: RuleScope, m: SlocScope | null): boolean {
  if (!m) return !s.wh && !s.zone && !s.rack_zone && !s.aisle && !s.bay && !s.level && !s.bin && !s.storage;
  if (s.wh && s.wh !== m.wh) return false;
  if (s.zone && s.zone !== m.zone && s.zone !== m.rack_zone) return false;
  if (s.rack_zone && s.rack_zone !== m.rack_zone) return false;
  if (s.aisle && s.aisle !== m.aisle) return false;
  if (s.bay && s.bay !== m.bay) return false;
  if (s.level && s.level !== m.level) return false;
  if (s.bin && s.bin !== m.bin) return false;
  if (s.storage && s.storage !== m.storage) return false;
  return true;
}

function scopeMatches(s: RuleScope, m: SlocScope): boolean {
  // Rule kategori hanya memutuskan apakah stok dihitung, bukan kapasitasnya.
  return !s.l1_category && locationScopeMatches(s, m);
}

export function resolveSloc(m: SlocScope): ResolvedCap {
  const cfg = getCapacity();
  let basis: Basis = cfg.basis_default;
  let util = cfg.utilization_pct;
  let maxQty = m.max_quantity;
  let maxCbm = m.max_volume;
  let qtyOverridden = false, cbmOverridden = false;
  for (const r of cfg.rules) {
    if (!scopeMatches(r.scope, m)) continue;
    if (r.set.basis) basis = r.set.basis;
    if (r.set.utilization_pct !== undefined) util = r.set.utilization_pct;
    if (r.set.max_qty !== undefined) { maxQty = r.set.max_qty; qtyOverridden = true; }
    if (r.set.max_cbm !== undefined) { maxCbm = r.set.max_cbm; cbmOverridden = true; }
  }
  const nominalCbm = Math.max(0, maxCbm);
  const nominalQty = Math.max(0, maxQty);
  return {
    basis,
    cap_qty: nominalQty,
    cap_cbm: nominalCbm * (util / 100),
    cap_cbm_nominal: nominalCbm,
    cap_qty_nominal: nominalQty,
    utilization_pct: util,
    qty_valid: qtyOverridden || m.max_quantity > 1,
    cbm_valid: cbmOverridden || m.max_volume > 1,
  };
}

/** Kategori mana yang dihitung sebagai okupansi (global exclude + rule count). */
export function categoryCounted(l1: string, loc: SlocScope | null): boolean {
  const cfg = getCapacity();
  let counted = !cfg.exclude_categories.includes(l1);
  for (const r of cfg.rules) {
    if (r.scope.l1_category !== l1 || r.set.count === undefined) continue;
    if (!locationScopeMatches(r.scope, loc)) continue;
    counted = r.set.count;
  }
  return counted;
}

export const countedStatuses = () => new Set(getCapacity().count_statuses);
