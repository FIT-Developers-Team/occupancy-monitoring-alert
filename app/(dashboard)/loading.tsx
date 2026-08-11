import LoadingPopup from "@/components/ui/loading-popup";
import RouteProgress from "@/components/ui/route-progress";

/**
 * Route-level fallback. This used to paint a full skeleton (heading bars, five
 * metric tiles, a panel block) the moment a navigation began, so every click
 * flashed a layout that was replaced milliseconds later.
 *
 * Two layers now, both silent for the first 180 ms: a progress bar that shows
 * the transition is moving without covering the page, and — only once a load
 * passes 900 ms, which on this dashboard means an uncached DuckDB scan — the
 * popup that names what is being waited for.
 */
export default function Loading() {
  return (
    <>
      <RouteProgress />
      <LoadingPopup delayMs={900} />
    </>
  );
}
