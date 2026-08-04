"use client";
import { useEffect, useRef } from "react";
import Chart from "./chart-core";
import { chartTheme } from "./palette";
import { useT } from "@/lib/i18n-client";

/** Riwayat 48 jam + garis proyeksi putus-putus menuju 100% memakai laju terkini. */
export default function ForecastChart({
  history, ratePctPerHour, height = 240,
}: { history: { t: string; pct: number }[]; ratePctPerHour: number; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { t, lang } = useT();
  useEffect(() => {
    if (!ref.current || history.length < 2) return;
    const th = chartTheme();
    const sorted = [...history].sort((a, b) => +new Date(a.t) - +new Date(b.t));
    const last = sorted[sorted.length - 1];
    const lastT = +new Date(last.t);

    const proj: { t: string; pct: number | null }[] = [];
    if (ratePctPerHour > 0.02) {
      let pct = last.pct;
      for (let h = 1; h <= 72 && pct < 102; h++) {
        pct = last.pct + ratePctPerHour * h;
        proj.push({ t: new Date(lastT + h * 3600_000).toISOString(), pct: Math.min(pct, 102) });
      }
    }
    const labels = [...sorted.map((p) => p.t), ...proj.map((p) => p.t)];
    const fmt = (iso: string) =>
      new Date(iso).toLocaleString(lang === "en" ? "en-GB" : "id-ID", { day: "2-digit", month: "short", hour: "2-digit", timeZone: "Asia/Jakarta" });

    const chart = new Chart(ref.current, {
      type: "line",
      data: {
        labels: labels.map(fmt),
        datasets: [
          { label: t("fc.historyLabel"), data: [...sorted.map((p) => p.pct), ...proj.map(() => null)],
            borderColor: "#3C83F6", borderWidth: 1.8, pointRadius: 0, tension: 0.25 },
          { label: t("fc.projectionLabel"), data: [...sorted.map(() => null), ...proj.map((p) => p.pct)],
            borderColor: "#EA580C", borderDash: [5, 4], borderWidth: 1.8, pointRadius: 0 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: th.ticks, font: th.font, boxWidth: 10 } },
        },
        scales: {
          x: { ticks: { color: th.ticks, font: th.font, maxTicksLimit: 9 }, grid: { color: th.grid } },
          y: { min: 40, max: 105,
            ticks: { color: th.ticks, font: th.font, callback: (v) => `${v}%` },
            grid: { color: th.grid } },
        },
      },
      plugins: [{
        id: "thresholdLines",
        afterDraw(c) {
          const { ctx, chartArea, scales } = c;
          if (!chartArea) return;
          for (const [val, color] of [[95, "#DC2626"], [100, "#0F172A"]] as const) {
            const y = scales.y.getPixelForValue(val);
            ctx.save();
            ctx.strokeStyle = String(color); ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(chartArea.left, y); ctx.lineTo(chartArea.right, y); ctx.stroke();
            ctx.fillStyle = String(color);
            ctx.font = "9px ui-monospace, SFMono-Regular, Consolas, monospace";
            ctx.fillText(`${val}%`, chartArea.right - 24, y - 3);
            ctx.restore();
          }
        },
      }],
    });
    return () => chart.destroy();
  }, [history, ratePctPerHour, lang]);
  if (history.length < 2) {
    return <div className="grid place-items-center text-center text-xs" style={{ height, color: "var(--text-muted)" }}>{t("fc.needsHistory")}</div>;
  }
  return <div style={{ height }}><canvas ref={ref} /></div>;
}
