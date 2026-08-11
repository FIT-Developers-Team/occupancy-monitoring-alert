"use client";

import { useEffect, useState } from "react";

/**
 * Slim progress bar for route transitions.
 *
 * A centred popup tells you something is happening but covers the page and
 * gives no sense of movement, so a two-second wait feels the same as a
 * ten-second one. This bar sits above the content instead: it starts quickly,
 * decelerates towards 90% and never completes on its own, because the route is
 * finished exactly when this component unmounts.
 *
 * It shares the popup's grace period, so navigations that resolve in under
 * ~180 ms still paint nothing at all.
 */
export default function RouteProgress({ delayMs = 180 }: { delayMs?: number }) {
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    const start = window.setTimeout(() => setProgress(8), delayMs);
    // Approach 90% asymptotically: each tick closes a fraction of the gap, so
    // the bar keeps moving on a slow load without ever implying completion.
    const tick = window.setInterval(() => {
      setProgress((current) => (current === null ? null : current + (90 - current) * 0.12));
    }, 240);
    return () => {
      window.clearTimeout(start);
      window.clearInterval(tick);
    };
  }, [delayMs]);

  if (progress === null) return null;
  return (
    <div className="route-progress" role="presentation">
      <span style={{ width: `${progress}%` }} />
    </div>
  );
}
