"use client";

import { useT } from "@/lib/i18n-client";

export default function Loading() {
  const { t } = useT();
  return (
    <div className="dashboard-page dashboard-route-loading" aria-busy="true" aria-label={t("common.loading")}>
      <div className="route-loading-status" role="status" aria-live="polite">
        <span className="route-loading-dot" aria-hidden />
        <span>{t("common.loading")}</span>
      </div>
      <div className="loading-heading">
        <span />
        <strong />
      </div>
      <div className="loading-metrics">
        {[0, 1, 2, 3, 4].map((i) => <span key={i} />)}
      </div>
      <div className="loading-panel" />
    </div>
  );
}
