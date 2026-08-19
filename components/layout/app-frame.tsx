"use client";
// Shell dashboard v3: sidebar open ⇄ icon-rail (desktop), drawer (mobile).
import { useCallback, useEffect, useState } from "react";
import Sidebar, { type NavMode } from "@/components/layout/sidebar";
import Topbar from "@/components/layout/topbar";
import { useT } from "@/lib/i18n-client";

export default function AppFrame({
  userName, role, dataVersion, children,
}: { userName: string; role: string; dataVersion: string; children: React.ReactNode }) {
  const [mode, setMode] = useState<NavMode>("open");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const { t } = useT();

  useEffect(() => {
    const stored = localStorage.getItem("wiom-nav");
    if (stored === "rail" || stored === "open") setMode(stored);
    setReady(true);
  }, []);

  // Laci navigasi ponsel menutupi seluruh layar. Tanpa dua hal ini ia berlaku
  // seperti panel yang menempel: halaman di belakangnya masih ikut bergulir di
  // bawah jari, dan Escape — refleks pertama untuk menutup apa pun yang
  // menutupi layar — tidak melakukan apa-apa.
  useEffect(() => {
    if (!mobileOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileOpen]);

  const toggleMode = useCallback(() => {
    setMode((m) => {
      const n: NavMode = m === "open" ? "rail" : "open";
      localStorage.setItem("wiom-nav", n);
      return n;
    });
  }, []);

  const onNavigate = useCallback(() => setMobileOpen(false), []);

  return (
    <div className="flex min-h-screen">
      {/* Rute pertama bagi pengguna keyboard dan pembaca layar: sepuluh tautan
          navigasi tidak perlu dilewati satu per satu pada setiap halaman. */}
      <a className="skip-link" href="#main-content">{t("shell.skipToContent")}</a>
      {ready && mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/45 md:hidden"
          onClick={() => setMobileOpen(false)} aria-hidden />
      )}
      <Sidebar mode={mode} mobileOpen={ready && mobileOpen} role={role}
        onNavigate={onNavigate} onToggle={toggleMode} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar userName={userName} role={role} dataVersion={dataVersion}
          onOpenMobileNav={() => setMobileOpen(true)} />
        <main id="main-content" tabIndex={-1}
          className="min-w-0 flex-1 space-y-3 p-3 sm:space-y-4 sm:p-4 md:p-5">
          {children}
        </main>
      </div>
    </div>
  );
}
