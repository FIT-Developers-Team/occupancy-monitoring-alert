import LoadingPopup from "@/components/ui/loading-popup";

/**
 * Route-level fallback. This used to paint a full skeleton (heading bars, five
 * metric tiles, a panel block) the moment a navigation began, so every click
 * flashed a layout that was replaced milliseconds later. One delayed popup
 * keeps the transition quiet instead.
 */
export default function Loading() {
  return <LoadingPopup />;
}
