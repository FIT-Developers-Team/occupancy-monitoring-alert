"use client";
// Shell dashboard v3: sidebar open ⇄ icon-rail (desktop), drawer (mobile).
import { useCallback, useEffect, useState } from "react";
import Sidebar, { type NavMode } from "@/components/layout/sidebar";
import Topbar from "@/components/layout/topbar";

export default function AppFrame({
  userName, role, children,
}: { userName: string; role: string; children: React.ReactNode }) {
  const [mode, setMode] = useState<NavMode>("open");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("wiom-nav");
    if (stored === "rail" || stored === "open") setMode(stored);
    setReady(true);
  }, []);

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
      {ready && mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/45 md:hidden"
          onClick={() => setMobileOpen(false)} aria-hidden />
      )}
      <Sidebar mode={mode} mobileOpen={ready && mobileOpen}
        onNavigate={onNavigate} onToggle={toggleMode} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar userName={userName} role={role}
          onOpenMobileNav={() => setMobileOpen(true)} />
        <main className="min-w-0 flex-1 space-y-3 p-3 sm:space-y-4 sm:p-4 md:p-5">{children}</main>
      </div>
    </div>
  );
}
