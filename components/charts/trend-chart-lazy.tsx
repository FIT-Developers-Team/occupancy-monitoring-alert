"use client";
import dynamic from "next/dynamic";
import LoadingPopup from "@/components/ui/loading-popup";
import type { TrendPoint } from "@/types";

// Chart.js is canvas-only, so it is useless during SSR and does not belong in
// the first payload. Loading it on demand keeps it out of the overview page's
// initial JS; the reserved box below prevents the layout from shifting when it
// arrives. `ssr: false` requires a client component, which is what this file is.
const TrendChart = dynamic(() => import("./trend-chart"), {
  ssr: false,
  loading: () => <LoadingPopup variant="inline" />,
});

export default function TrendChartLazy({
  points,
  height = 230,
}: {
  points: TrendPoint[];
  height?: number;
}) {
  return (
    <div style={{ height }}>
      <TrendChart points={points} height={height} />
    </div>
  );
}
