"use client";
// What-If v4 — slider halus (step 0.5) untuk Inbound & Outbound; laju dari flow snapshot.
import { useMemo, useState } from "react";
import type { ForecastRow } from "@/types";
import { hoursToTarget } from "@/lib/forecast";
import { formatters } from "@/lib/utils";
import { useT } from "@/lib/i18n-client";
import dynamic from "next/dynamic";
import LoadingPopup from "@/components/ui/loading-popup";

// Keeps Chart.js out of the forecast page's initial bundle; it only loads once
// this panel actually renders a chart.
const ForecastChart = dynamic(() => import("@/components/charts/forecast-chart"), {
  ssr: false,
  loading: () => <LoadingPopup variant="inline" />,
});

export default function WhatIfPanel({ rows }: { rows: ForecastRow[] }) {
  const { t, lang } = useT();
  const f = formatters(lang);
  const [wh, setWh] = useState(rows[0]?.warehouse ?? "");
  const [inAdj, setInAdj] = useState(0);
  const [outAdj, setOutAdj] = useState(0);

  const row = rows.find((r) => r.warehouse === wh);

  const sim = useMemo(() => {
    if (!row) return null;
    const inR = row.in_rate * (1 + inAdj / 100);
    const outR = row.out_rate * (1 + outAdj / 100);
    const net = inR - outR;
    const rate = row.cap_basis > 0 ? (net / row.cap_basis) * 100 : 0;
    return { inR, outR, net, rate,
      h95: hoursToTarget(row.current_pct, rate, 95),
      h100: hoursToTarget(row.current_pct, rate, 100) };
  }, [row, inAdj, outAdj]);

  if (!row || !sim) return null;
  const noFlow = row.in_rate === 0 && row.out_rate === 0;
  const unavailable = !row.forecast_ready;
  const changed = inAdj !== 0 || outAdj !== 0;
  const fmtFlow = (v: number) => (row.flow_unit === "unit" ? f.num(v, 1) : f.num(v, 3));

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
      <div className="space-y-4">
        <label className="block space-y-1">
          <span className="eyebrow">{t("common.warehouse")}</span>
          <select className="input" value={wh}
            onChange={(e) => { setWh(e.target.value); setInAdj(0); setOutAdj(0); }}>
            {rows.map((r) => <option key={r.warehouse} value={r.warehouse}>{r.warehouse} — {r.name}</option>)}
          </select>
        </label>

        {([[t("fc.inbound"), inAdj, setInAdj, row.in_rate, sim.inR],
           [t("fc.outbound"), outAdj, setOutAdj, row.out_rate, sim.outR]] as const).map(
          ([label, val, set, base, now]) => (
            <div key={label} className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <span className="eyebrow">{label}</span>
                <span className="num text-xs font-semibold"
                  style={{ color: val === 0 ? "var(--text-muted)" : "var(--accent)" }}>
                  {val > 0 ? "+" : ""}{val.toFixed(1)}%
                </span>
              </div>
              <input type="range" min={-75} max={150} step={0.5} value={val} disabled={unavailable || noFlow}
                onChange={(e) => (set as (n: number) => void)(Number(e.target.value))}
                className="slider" aria-label={label} />
              <div className="num flex justify-between text-[10.5px]" style={{ color: "var(--text-muted)" }}>
                <span>{t("fc.baseline")} {fmtFlow(base)}</span>
                <span style={{ color: val === 0 ? undefined : "var(--text)" }}>
                  → {fmtFlow(now)} {row.flow_unit}{t("common.perHour")}
                </span>
              </div>
            </div>
          ))}

        <div className="card card-pad space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="eyebrow">{t("fc.simRate")}</span>
            <span className="num text-sm font-semibold"
              style={{ color: sim.rate > 0 ? "var(--st-warning-fg)" : sim.rate < 0 ? "var(--st-normal-fg)" : undefined }}>
              {sim.rate >= 0 ? "+" : ""}{sim.rate.toFixed(3)} %{t("common.perHour")}
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="eyebrow">{t("fc.to95")}</span>
            <span className="num text-sm font-semibold"
              style={{ color: sim.h95 !== null && sim.h95 < 12 ? "var(--st-critical-fg)" : "var(--text)" }}>
              {f.hours(sim.h95)}
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="eyebrow">{t("fc.to100")}</span>
            <span className="num text-sm font-semibold">{f.hours(sim.h100)}</span>
          </div>
          {changed && (
            <button className="btn btn-ghost btn-sm w-full justify-center"
              onClick={() => { setInAdj(0); setOutAdj(0); }}>
              {t("fc.resetBaseline")}
            </button>
          )}
          {unavailable ? (
            <p className="text-[10.5px]" style={{ color: "var(--text-muted)" }}>
              {t("fc.needsHistory")}
            </p>
          ) : noFlow ? (
            <p className="text-[10.5px]" style={{ color: "var(--text-muted)" }}>{t("fc.noFlow")}</p>
          ) : null}
        </div>
      </div>
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="panel-title">{row.warehouse} — {t("fc.projection")} ({row.basis.toUpperCase()})</span>
          <span className="chip chip-accent">{row.current_pct}%</span>
        </div>
        <ForecastChart history={row.trend} ratePctPerHour={sim.rate} height={300} />
      </div>
    </div>
  );
}
