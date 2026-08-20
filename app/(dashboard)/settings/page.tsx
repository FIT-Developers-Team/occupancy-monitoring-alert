import { redirect } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import Section from "@/components/ui/section";
import SettingsTabs from "@/components/domain/settings-tabs";
import PageHeader from "@/components/ui/page-header";
import { getT } from "@/lib/i18n";
import { configStorageInfo } from "@/lib/runtime-config";
import { pageTitle } from "@/lib/page-metadata";

export const dynamic = "force-dynamic";
export const generateMetadata = pageTitle("nav.settings");

export default async function SettingsPage() {
  const [user, t] = await Promise.all([currentUser(), getT()]);
  const admin = user ? isAdmin(user.role) : false;
  if (!admin) redirect("/");
  // Hanya status "dapat disimpan atau tidak" yang sampai ke layar. Lokasi
  // folder di server bukan informasi yang membantu admin dan tidak perlu
  // ditampilkan di antarmuka; /api/health tetap melaporkannya untuk monitoring.
  const info = configStorageInfo();
  const storage = { writable: info.writable, durable: info.durable };
  return (
    <div className="dashboard-page">
      {/* One heading, then the controls. The tab strip already names each
          configuration area, so the eyebrow/description/section labels that
          used to stack above it only pushed the form further down. */}
      <PageHeader title={t("set.ui.page.title")} />
      <Section title={t("set.ui.page.sectionTitle")}>
      {/* Status penyimpanan dibaca di server: informasinya berlaku untuk semua
          tab dan tidak perlu satu permintaan tambahan per tab. */}
      <SettingsTabs storage={storage} />
      </Section>
    </div>
  );
}
