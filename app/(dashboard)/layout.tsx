import { redirect } from "next/navigation";
import AppFrame from "@/components/layout/app-frame";
import { currentUser } from "@/lib/auth";
import { historyDataVersion } from "@/lib/db";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  // Snapshot yang menghasilkan HTML ini. Topbar membandingkannya dengan versi
  // yang dilaporkan /api/data-status untuk tahu kapan layar sudah tertinggal.
  // Diambil dari render, bukan dari polling pertama di browser: sync yang
  // mendarat di antara render dan polling pertama kalau tidak akan terlewat
  // sampai sync berikutnya.
  return (
    <AppFrame userName={user.name} role={user.role} dataVersion={historyDataVersion()}>
      {children}
    </AppFrame>
  );
}
