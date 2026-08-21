"use client";
import { useEffect, useRef } from "react";
import Chart from "./chart-core";
import { WH_PALETTE, chartTheme, occupancyAxis } from "./palette";
import { useThemeVersion } from "./use-chart-theme";
import { useT } from "@/lib/i18n-client";
import { localeOf } from "@/lib/i18n-dict";
import type { TrendPoint } from "@/types";

/** Batas kapasitas fisik — satu-satunya garis acuan yang berlaku sama di semua gudang. */
const CAPACITY_MARK = 100;

export default function TrendChart({ points, height = 230 }: { points: TrendPoint[]; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { t, lang } = useT();
  const themeVersion = useThemeVersion();

  useEffect(() => {
    if (!ref.current) return;
    const th = chartTheme();
    const byWh = new Map<string, TrendPoint[]>();
    for (const p of points) {
      if (!byWh.has(p.warehouse)) byWh.set(p.warehouse, []);
      byWh.get(p.warehouse)!.push(p);
    }
    const labels = [...new Set(points.map((p) => p.t))].sort();
    const locale = localeOf(lang);
    const fmt = (iso: string) =>
      new Date(iso).toLocaleString(locale, { day: "2-digit", month: "short", hour: "2-digit", timeZone: "Asia/Jakarta" });
    // Sumbu mengikuti data, bukan sebaliknya. Lihat occupancyAxis().
    const axis = occupancyAxis(points.map((p) => p.pct));
    const showCapacityMark = CAPACITY_MARK >= axis.min && CAPACITY_MARK <= axis.max;

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
            min: axis.min, max: axis.max,
            ticks: { color: th.ticks, font: th.font, callback: (v) => `${v}%` },
            grid: { color: th.grid },
          },
        },
      },
      // Garis kapasitas hanya digambar bila benar-benar berada di dalam rentang
      // yang tampil. Memaksakannya pada jaringan yang berjalan di 20% akan
      // menarik sumbu sampai 100 dan memampatkan seluruh datanya kembali ke
      // dasar panel — persis masalah yang diperbaiki sumbu dinamis ini.
      plugins: showCapacityMark ? [{
        id: "capacityLine",
        afterDatasetsDraw(c) {
          const { ctx, chartArea, scales } = c;
          if (!chartArea) return;
          const y = scales.y.getPixelForValue(CAPACITY_MARK);
          ctx.save();
          ctx.strokeStyle = th.breach;
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(chartArea.left, y);
          ctx.lineTo(chartArea.right, y);
          ctx.stroke();
          ctx.fillStyle = th.breach;
          ctx.font = `9px ${th.font.family}`;
          ctx.textAlign = "right";
          ctx.fillText(t("chart.capacityMark"), chartArea.right - 2, y - 3);
          ctx.restore();
        },
      }] : [],
    });
    return () => chart.destroy();
  }, [points, lang, t, themeVersion]);

  return <div style={{ height }}><canvas ref={ref} /></div>;
}
