"use client";
import { useEffect, useRef } from "react";
import Chart from "chart.js/auto";
import { chartTheme } from "./palette";

// Pareto v2 — bar FIT Blue + line kumulatif amber tebal, hover mode index.
export default function ParetoChart({
  items, height = 230,
}: { items: { label: string; count: number }[]; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const th = chartTheme();
    const sorted = [...items].sort((a, b) => b.count - a.count);
    const total = sorted.reduce((s, i) => s + i.count, 0) || 1;
    let run = 0;
    const cumulative = sorted.map((i) => { run += i.count; return Math.round((run / total) * 1000) / 10; });
    const AMBER = "#F59E0B";
    const chart = new Chart(ref.current, {
      data: {
        labels: sorted.map((i) => i.label),
        datasets: [
          { type: "bar", label: "Jumlah", data: sorted.map((i) => i.count),
            backgroundColor: "#3C83F6", hoverBackgroundColor: "#2464E0",
            borderRadius: 4, maxBarThickness: 64, yAxisID: "y", order: 2 },
          { type: "line", label: "Kumulatif %", data: cumulative,
            borderColor: AMBER, backgroundColor: AMBER,
            pointBackgroundColor: "#FFFFFF", pointBorderColor: AMBER, pointBorderWidth: 2,
            borderWidth: 2.5, pointRadius: 3.5, pointHoverRadius: 5,
            tension: 0.25, yAxisID: "y1", order: 1 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: th.ticks, font: th.font, boxWidth: 10, usePointStyle: true } },
          tooltip: {
            callbacks: {
              label: (ctx) => ctx.dataset.type === "line"
                ? ` Kumulatif: ${ctx.parsed.y}%`
                : ` Jumlah: ${ctx.parsed.y} alert`,
            },
          },
        },
        scales: {
          x: { ticks: { color: th.ticks, font: th.font }, grid: { display: false } },
          y: { beginAtZero: true, title: { display: true, text: "Jumlah", color: th.ticks, font: th.font },
            ticks: { color: th.ticks, font: th.font, precision: 0 }, grid: { color: th.grid } },
          y1: { position: "right", min: 0, max: 100,
            ticks: { color: AMBER, font: th.font, callback: (v) => `${v}%` }, grid: { display: false } },
        },
      },
    });
    return () => chart.destroy();
  }, [items]);
  return <div style={{ height }}><canvas ref={ref} /></div>;
}
