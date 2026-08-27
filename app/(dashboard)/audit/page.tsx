import { auditLog, notificationLog } from "@/lib/alerts/store";
import { getLang, getT } from "@/lib/i18n";
import { formatters } from "@/lib/utils";
import Section from "@/components/ui/section";
import PageHeader from "@/components/ui/page-header";
import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { pageTitle } from "@/lib/page-metadata";

export const dynamic = "force-dynamic";
export const generateMetadata = pageTitle("nav.audit");

export default async function AuditPage() {
  // Otorisasi diperiksa sebelum kuerinya, bukan sesudah. Bentuk lama menarik
  // 150 baris jejak audit dan log notifikasi lebih dulu, lalu membuangnya lewat
  // redirect — pekerjaan basis data yang selalu terbuang untuk supervisor yang
  // membuka URL ini langsung.
  const user = await currentUser();
  if (!user || !isAdmin(user.role)) redirect("/");
  const [audits, notifications, t, lang] = await Promise.all([
    auditLog(100),
    notificationLog(50),
    getT(),
    getLang(),
  ]);
  const f = formatters(lang);

  return (
    <div className="dashboard-page">
      <PageHeader
        eyebrow={t("audit.header.eyebrow")}
        title={t("audit.header.title")}
        description={t("audit.header.description")}
      />

      <Section eyebrow={t("audit.activity.eyebrow")} title={t("audit.activity.title")}>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{t("common.time")}</th>
                <th scope="col">{t("audit.column.actor")}</th>
                <th scope="col">{t("audit.column.action")}</th>
                <th scope="col">{t("audit.column.entity")}</th>
                <th scope="col">{t("audit.column.detail")}</th>
              </tr>
            </thead>
            <tbody>
              {(audits as Array<Record<string, unknown>>).map((audit) => (
                <tr key={String(audit.id)}>
                  <td className="num whitespace-nowrap">{f.dateTime(String(audit.at))}</td>
                  <td className="num">{String(audit.actor)}</td>
                  <td><span className="chip">{String(audit.action)}</span></td>
                  <td className="num">{String(audit.entity)}</td>
                  <td
                    className="max-w-[380px] truncate num text-[10.5px]"
                    title={`${audit.before_json ?? ""} → ${audit.after_json ?? ""}`}
                    style={{ color: "var(--text-muted)" }}
                  >
                    {String(audit.after_json ?? audit.before_json ?? "—")}
                  </td>
                </tr>
              ))}
              {audits.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-xs" style={{ color: "var(--text-muted)" }}>
                    {t("audit.empty.activity")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <Section eyebrow={t("audit.notification.eyebrow")} title={t("audit.notification.title")}>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{t("common.time")}</th>
                <th scope="col">{t("audit.column.channel")}</th>
                <th scope="col">{t("audit.column.recipient")}</th>
                <th scope="col">{t("common.status")}</th>
                <th scope="col">{t("audit.column.alert")}</th>
                <th scope="col">{t("audit.column.message")}</th>
              </tr>
            </thead>
            <tbody>
              {(notifications as Array<Record<string, unknown>>).map((notification) => {
                const status = String(notification.status);
                return (
                  <tr key={String(notification.id)}>
                    <td className="num whitespace-nowrap">{f.dateTime(String(notification.at))}</td>
                    <td><span className="chip">{String(notification.channel)}</span></td>
                    <td className="num">{String(notification.recipient)}</td>
                    <td>
                      <span
                        className={`badge ${
                          status === "SENT"
                            ? "badge-normal"
                            : status === "FAILED"
                              ? "badge-critical"
                              : "badge-monitor"
                        }`}
                      >
                        {t(`audit.status.${status}`, status)}
                      </span>
                    </td>
                    <td className="num">{String(notification.alert_id ?? "—")}</td>
                    <td className="max-w-[300px] truncate text-[10.5px]" style={{ color: "var(--text-muted)" }}>
                      {String(notification.message ?? "")}
                    </td>
                  </tr>
                );
              })}
              {notifications.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-xs" style={{ color: "var(--text-muted)" }}>
                    {t("audit.empty.notification")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
