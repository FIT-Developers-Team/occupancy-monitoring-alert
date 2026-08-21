import { redirect } from "next/navigation";
import AppFrame from "@/components/layout/app-frame";
import { currentUser } from "@/lib/auth";
import { historyDataVersion } from "@/lib/db";
import { getWarehouses } from "@/lib/config";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  // Snapshot yang menghasilkan HTML ini. Topbar membandingkannya dengan versi
  // yang dilaporkan /api/data-status untuk tahu kapan layar sudah tertinggal.
  // Diambil dari render, bukan dari polling pertama di browser: sync yang
  // mendarat di antara render dan polling pertama kalau tidak akan terlewat
  // sampai sync berikutnya.
  return (
    <AppFrame
      userName={user.name}
      role={user.role}
      dataVersion={historyDataVersion()}
      // Daftar gudang berasal dari konfigurasi, bukan dari salinan yang
      // ditulis ulang di dalam command palette. Salinan itu tidak pernah ikut
      // berubah ketika admin menambah atau mengganti gudang di Pengaturan.
      warehouses={getWarehouses().warehouses.map((warehouse) => warehouse.code)}
    >
      {children}
    </AppFrame>
  );
}
