import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { getLang } from "@/lib/i18n";
import { I18nProvider } from "@/lib/i18n-client";

// Self-hosted (subset latin) — tanpa dependensi runtime ke Google Fonts.
const poppins = localFont({
  src: [
    { path: "./fonts/poppins-400.woff2", weight: "400" },
    { path: "./fonts/poppins-500.woff2", weight: "500" },
    { path: "./fonts/poppins-600.woff2", weight: "600" },
    { path: "./fonts/poppins-700.woff2", weight: "700" },
  ],
  variable: "--font-poppins",
  display: "swap",
});
const nunito = localFont({
  src: [{ path: "./fonts/nunito-var.woff2", weight: "400 700" }],
  variable: "--font-nunito",
  display: "swap",
});
const inconsolata = localFont({
  src: [{ path: "./fonts/inconsolata-var.woff2", weight: "400 700" }],
  variable: "--font-inconsolata",
  display: "swap",
});

export const metadata: Metadata = {
  title: "WIOM Control Tower — FIT",
  description:
    "Warehouse Inventory Occupancy Monitoring & Alert Control Tower — Fulfillment Intelligence Team",
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
      <body
        className={`${poppins.variable} ${nunito.variable} ${inconsolata.variable} min-h-screen`}
      >
        <I18nProvider initialLang={lang}>{children}</I18nProvider>
      </body>
    </html>
  );
}
