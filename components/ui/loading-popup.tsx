"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n-client";

/**
 * Minimal loading indicator, shared by route transitions and lazy-loaded
 * components.
 *
 * The flicker this replaces came from showing a full-page skeleton the instant
 * a navigation started: most navigations resolve in well under 200 ms, so the
 * skeleton painted and disappeared again as a flash. Here nothing renders until
 * `delayMs` has passed, so a fast load shows no indicator at all and a slow one
 * gets a single calm popup.
 */
export default function LoadingPopup({
  label,
  delayMs = 180,
  variant = "overlay",
}: {
  label?: string;
  /** Grace period before anything is painted. 0 shows immediately. */
  delayMs?: number;
  /** "overlay" floats above the page; "inline" fills its container. */
  variant?: "overlay" | "inline";
}) {
  const { t } = useT();
  const [visible, setVisible] = useState(delayMs === 0);

  useEffect(() => {
    if (delayMs === 0) return;
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);

  // Inline slots still have to hold their space during the grace period,
  // otherwise the surrounding layout collapses and then jumps back.
  if (!visible) {
    return variant === "inline" ? <div className="loading-hold" aria-hidden /> : null;
  }

  const text = label ?? t("common.loading");
  return (
    <div className={`loading-popup loading-popup-${variant}`} role="status" aria-live="polite">
      <div className="loading-popup-card">
        <span className="loading-popup-spinner" aria-hidden />
        <span className="loading-popup-text">{text}</span>
      </div>
    </div>
  );
}
