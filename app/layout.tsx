import type { Metadata } from "next";
import "./globals.css";
import { getLang } from "@/lib/i18n";
import { I18nProvider } from "@/lib/i18n-client";

export const metadata: Metadata = {
  // Judul per halaman (lihat lib/page-metadata.ts) mengisi %s; halaman tanpa
  // judul sendiri jatuh ke nama produk lengkap.
  title: {
    template: "%s · FIT Occupancy",
    default: "FIT Occupancy Alert and Monitoring",
  },
  description: "Pemantauan okupansi, kapasitas, dan alert gudang untuk Fulfillment Intelligence Team.",
};

const themeInit = `
try {
  const t = localStorage.getItem('wiom-theme');
  if (t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
} catch {}
`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = await getLang();
  return (
    <html lang={lang === "en" ? "en-GB" : "id"} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="min-h-screen">
        <I18nProvider initialLang={lang}>{children}</I18nProvider>
      </body>
    </html>
  );
}
