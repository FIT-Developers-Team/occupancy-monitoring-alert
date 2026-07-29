"use client";
import { useT } from "@/lib/i18n-client";

export default function DashboardError({ error, reset }: { error: Error; reset: () => void }) {
  const { t } = useT();
  const noDb = /npm run seed|tidak ditemukan/i.test(error.message);
  return (
    <div className="card card-pad max-w-xl space-y-3">
      <div className="eyebrow">{t("error.eyebrow")}</div>
      <h2 className="text-base font-semibold">
        {noDb ? t("error.database.title") : t("error.page.title")}
      </h2>
      <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
        {noDb ? t("error.database.body") : error.message}
      </p>
      <button className="btn btn-primary btn-sm" onClick={reset}>{t("error.retry")}</button>
    </div>
  );
}
