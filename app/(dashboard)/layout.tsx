import { redirect } from "next/navigation";
import AppFrame from "@/components/layout/app-frame";
import { currentUser } from "@/lib/auth";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  return (
    <AppFrame userName={user.name} role={user.role}>
      {children}
    </AppFrame>
  );
}
