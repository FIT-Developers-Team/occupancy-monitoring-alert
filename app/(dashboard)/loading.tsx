import RouteProgress from "@/components/ui/route-progress";

/**
 * Keep the current screen readable while the next route streams. Expensive
 * read models return their last valid synced data while refreshing in the
 * background, so a slim non-blocking bar is the only transition signal.
 */
export default function Loading() {
  return <RouteProgress delayMs={240} />;
}
