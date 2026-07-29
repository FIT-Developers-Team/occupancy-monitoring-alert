import { currentUser, isAdmin } from "@/lib/auth";
import Section from "@/components/ui/section";
import SettingsTabs from "@/components/domain/settings-tabs";
import PageHeader from "@/components/ui/page-header";
import { getT } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [user, t] = await Promise.all([currentUser(), getT()]);
  const admin = user ? isAdmin(user.role) : false;
  return (
    <div className="dashboard-page">
      <PageHeader
        eyebrow={t("set.ui.page.eyebrow")}
        title={t("set.ui.page.title")}
        description={t("set.ui.page.description")}
      />
      <Section eyebrow={t("set.ui.page.sectionEyebrow")} title={t("set.ui.page.sectionTitle")}>
      {admin ? (
        <SettingsTabs />
      ) : (
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          {t("set.ui.page.adminOnly")}
        </p>
      )}
      </Section>
    </div>
  );
}
