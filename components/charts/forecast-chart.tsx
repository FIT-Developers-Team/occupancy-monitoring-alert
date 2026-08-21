"use client";
import { useEffect, useRef } from "react";
import Chart from "./chart-core";
import { chartTheme, occupancyAxis } from "./palette";
import { useThemeVersion } from "./use-chart-theme";
import { useT } from "@/lib/i18n-client";
import { localeOf } from "@/lib/i18n-dict";

/** Riwayat 48 jam + garis proyeksi putus-putus menuju 100% memakai laju terkini. */
export default function ForecastChart({
  history, ratePctPerHour, height = 240,
}: { history: { t: string; pct: number }[]; ratePctPerHour: number; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { t, lang } = useT();
  const themeVersion = useThemeVersion();
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
    const locale = localeOf(lang);
    const fmt = (iso: string) =>
      new Date(iso).toLocaleString(locale, { day: "2-digit", month: "short", hour: "2-digit", timeZone: "Asia/Jakarta" });
    // Sumbu mencakup riwayat DAN proyeksinya, jadi gudang yang berjalan di 7%
    // tetap terbaca sementara gudang yang menuju penuh tetap memperlihatkan
    // perjalanannya sampai melewati batas kapasitas.
    const axis = occupancyAxis([...sorted.map((p) => p.pct), ...proj.map((p) => p.pct)]);
    // Ambang hanya digambar bila memang berada di dalam rentang yang tampil;
    // memaksakan garis 95/100 pada gudang yang jauh di bawahnya akan menarik
    // sumbu ke atas dan memampatkan datanya kembali ke dasar panel.
    const marks = ([[95, th.critical], [100, th.breach]] as const)
      .filter(([value]) => value >= axis.min && value <= axis.max);

    const chart = new Chart(ref.current, {
      type: "line",
      data: {
        labels: labels.map(fmt),
        datasets: [
          { label: t("fc.historyLabel"), data: [...sorted.map((p) => p.pct), ...proj.map(() => null)],
            borderColor: th.accent, borderWidth: 1.8, pointRadius: 0, tension: 0.25 },
          { label: t("fc.projectionLabel"), data: [...sorted.map(() => null), ...proj.map((p) => p.pct)],
            borderColor: th.critical, borderDash: [5, 4], borderWidth: 1.8, pointRadius: 0 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: th.ticks, font: th.font, boxWidth: 10 } },
          tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${c.formattedValue}%` } },
        },
        scales: {
          x: { ticks: { color: th.ticks, font: th.font, maxTicksLimit: 9 }, grid: { color: th.grid } },
          y: { min: axis.min, max: axis.max,
            ticks: { color: th.ticks, font: th.font, callback: (v) => `${v}%` },
            grid: { color: th.grid } },
        },
      },
      plugins: marks.length ? [{
        id: "thresholdLines",
        afterDatasetsDraw(c) {
          const { ctx, chartArea, scales } = c;
          if (!chartArea) return;
          for (const [value, color] of marks) {
            const y = scales.y.getPixelForValue(value);
            ctx.save();
            ctx.strokeStyle = color; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(chartArea.left, y); ctx.lineTo(chartArea.right, y); ctx.stroke();
            ctx.fillStyle = color;
            ctx.font = `9px ${th.font.family}`;
            ctx.textAlign = "right";
            ctx.fillText(`${value}%`, chartArea.right - 2, y - 3);
            ctx.restore();
          }
        },
      }] : [],
    });
    return () => chart.destroy();
  }, [history, ratePctPerHour, lang, t, themeVersion]);
  if (history.length < 2) {
    return <div className="grid place-items-center text-center text-xs" style={{ height, color: "var(--text-muted)" }}>{t("fc.needsHistory")}</div>;
  }
  return <div style={{ height }}><canvas ref={ref} /></div>;
}
