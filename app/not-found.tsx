import Link from "next/link";
import { getT } from "@/lib/i18n";

export default async function NotFound() {
  const t = await getT();
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="card card-pad max-w-sm space-y-3 text-center">
        <div className="eyebrow">404</div>
        <h1 className="text-base font-semibold">{t("error.notFound.title")}</h1>
        <Link className="btn btn-primary btn-sm justify-center" href="/">{t("error.notFound.back")}</Link>
      </div>
    </main>
  );
}
