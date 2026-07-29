"use client";

import { useT } from "@/lib/i18n-client";

export default function Loading() {
  const { t } = useT();
  return (
    <div className="dashboard-page" aria-busy="true" aria-label={t("common.loading")}>
      <div className="loading-heading">
        <span />
        <strong />
      </div>
      <div className="loading-metrics">
        {[0, 1, 2, 3].map((i) => <span key={i} />)}
      </div>
      <div className="loading-panel" />
    </div>
  );
}
