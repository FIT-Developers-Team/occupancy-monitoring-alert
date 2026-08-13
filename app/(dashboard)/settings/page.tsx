import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import Section from "@/components/ui/section";
import SettingsTabs from "@/components/domain/settings-tabs";
import PageHeader from "@/components/ui/page-header";
import { getT } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [user, t] = await Promise.all([currentUser(), getT()]);
  const admin = user ? isAdmin(user.role) : false;
  if (!admin) redirect("/");
  return (
    <div className="dashboard-page">
      {/* One heading, then the controls. The tab strip already names each
          configuration area, so the eyebrow/description/section labels that
          used to stack above it only pushed the form further down. */}
      <PageHeader title={t("set.ui.page.title")} />
      <Section title={t("set.ui.page.sectionTitle")}>
      <SettingsTabs />
      </Section>
    </div>
  );
}
