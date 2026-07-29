import type { OccupancyStatus, Severity } from "@/types";

export const fmtNum = (n: number | null | undefined, digits = 0): string =>
  n === null || n === undefined || Number.isNaN(n)
    ? "—"
    : n.toLocaleString("id-ID", { maximumFractionDigits: digits, minimumFractionDigits: digits });

/** Format m³ adaptif: 0,039 · 2,55 · 12,4 · 130 */
export const fmtCbm = (n: number | null | undefined): string => {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const a = Math.abs(n);
  const d = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
  return n.toLocaleString("id-ID", { maximumFractionDigits: d, minimumFractionDigits: 0 });
};

export const fmtPct = (n: number | null | undefined, digits = 1): string =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : `${fmtNum(n, digits)}%`;

export const fmtDateTime = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("id-ID", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta",
  }) + " WIB";
};

export const fmtHours = (h: number | null): string => {
  if (h === null || !Number.isFinite(h)) return "stabil";
  if (h < 1) return `≈ ${Math.max(1, Math.round(h * 60))} mnt`;
  if (h < 48) return `≈ ${Math.round(h)} jam`;
  return `≈ ${Math.round(h / 24)} hari`;
};

export const statusLabel: Record<OccupancyStatus, string> = {
  NORMAL: "Normal", MONITOR: "Pantau", WARNING: "Waspada", CRITICAL: "Kritis", BREACH: "Breach",
};

export const severityOrder: Severity[] = ["INFO", "WARNING", "HIGH", "CRITICAL", "EMERGENCY"];
export const severityRank = (s: Severity) => severityOrder.indexOf(s);

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
