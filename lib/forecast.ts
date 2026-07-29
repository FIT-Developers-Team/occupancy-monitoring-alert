// Time-to-Full Horizon: dari tren okupansi + laju inbound/outbound.
// Rate = weighted moving average dari delta okupansi per jam (bobot linier,
// titik terbaru paling berat) — pola WMA yang sama dengan FIT Daily MP Advisor.

export interface RatePoint { t: string; pct: number }

export function wmaRatePctPerHour(points: RatePoint[], lookback = 12): number {
  const pts = [...points]
    .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())
    .slice(-(lookback + 1));
  if (pts.length < 3) return 0;
  const deltas: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const hours =
      (new Date(pts[i].t).getTime() - new Date(pts[i - 1].t).getTime()) / 3_600_000;
    if (hours <= 0) continue;
    deltas.push((pts[i].pct - pts[i - 1].pct) / hours);
  }
  if (!deltas.length) return 0;
  let num = 0, den = 0;
  deltas.forEach((d, i) => {
    const w = i + 1; // linear weights, newest heaviest
    num += d * w;
    den += w;
  });
  return num / den;
}

/** Jam menuju target okupansi; null bila laju ~0 atau menurun (stabil). */
export function hoursToTarget(currentPct: number, ratePctPerHour: number, targetPct: number): number | null {
  if (currentPct >= targetPct) return 0;
  if (ratePctPerHour < 0.02) return null;
  return (targetPct - currentPct) / ratePctPerHour;
}

/** What-if: skala ulang komponen inbound/outbound lalu hitung ulang laju. */
export function adjustedRate(
  inPerHourQty: number,
  outPerHourQty: number,
  capacityQty: number,
  inboundAdjPct: number,
  outboundAdjPct: number
): number {
  if (capacityQty <= 0) return 0;
  const netQty =
    inPerHourQty * (1 + inboundAdjPct / 100) - outPerHourQty * (1 + outboundAdjPct / 100);
  return (netQty / capacityQty) * 100;
}
