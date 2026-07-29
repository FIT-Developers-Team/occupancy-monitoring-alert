export const WH_PALETTE = [
  "#3C83F6", "#14B8A6", "#EA580C", "#8B5CF6",
  "#DC2626", "#CA8A04", "#0EA5E9", "#64748B",
];
export function chartTheme() {
  const dark = typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");
  return {
    grid: dark ? "rgba(148,163,184,0.14)" : "rgba(100,116,139,0.16)",
    ticks: dark ? "#94A3B8" : "#64748B",
    font: { family: "Inconsolata, monospace", size: 10 },
  };
}
