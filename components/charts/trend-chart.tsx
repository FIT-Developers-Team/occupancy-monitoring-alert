"use client";
import { useEffect, useRef } from "react";
import Chart from "./chart-core";
import { WH_PALETTE, chartTheme } from "./palette";
import type { TrendPoint } from "@/types";

export default function TrendChart({ points, height = 230 }: { points: TrendPoint[]; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const th = chartTheme();
    const byWh = new Map<string, TrendPoint[]>();
    for (const p of points) {
      if (!byWh.has(p.warehouse)) byWh.set(p.warehouse, []);
      byWh.get(p.warehouse)!.push(p);
    }
    const labels = [...new Set(points.map((p) => p.t))].sort();
    const fmt = (iso: string) =>
      new Date(iso).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", timeZone: "Asia/Jakarta" });

    const chart = new Chart(ref.current, {
      type: "line",
      data: {
        labels: labels.map(fmt),
        datasets: [...byWh.entries()].map(([wh, pts], i) => {
          const m = new Map(pts.map((p) => [p.t, p.pct]));
          return {
            label: wh,
            data: labels.map((l) => m.get(l) ?? null),
            borderColor: WH_PALETTE[i % WH_PALETTE.length],
            backgroundColor: WH_PALETTE[i % WH_PALETTE.length],
            borderWidth: 1.6, pointRadius: 0, tension: 0.25, spanGaps: true,
          };
        }),
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: th.ticks, font: th.font, boxWidth: 10, boxHeight: 10 } },
          tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${c.formattedValue}%` } },
        },
        scales: {
          x: { ticks: { color: th.ticks, font: th.font, maxTicksLimit: 8 }, grid: { color: th.grid } },
          y: {
            min: 40, max: 105,
            ticks: { color: th.ticks, font: th.font, callback: (v) => `${v}%` },
            grid: { color: th.grid },
          },
        },
      },
    });
    return () => chart.destroy();
  }, [points]);

  return <div style={{ height }}><canvas ref={ref} /></div>;
}
