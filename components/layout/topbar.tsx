"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import ThemeToggle from "@/components/ui/theme-toggle";
import CommandPalette from "@/components/ui/command-palette";
import BasisSwitch from "@/components/ui/basis-switch";
import LangSwitch from "@/components/ui/lang-switch";
import { useT } from "@/lib/i18n-client";

const INTERVAL_S = 60;

export default function Topbar({
  userName, role, onOpenMobileNav,
}: { userName: string; role: string; onOpenMobileNav: () => void }) {
  const router = useRouter();
  const { t } = useT();
  const [left, setLeft] = useState(INTERVAL_S);
  const [paused, setPaused] = useState(false);
  const roleLabel = t(`shell.role.${role}`, role);

  const refresh = useCallback(() => {
    router.refresh();
    setLeft(INTERVAL_S);
  }, [router]);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => {
      setLeft((s) => {
        if (s <= 1) { router.refresh(); return INTERVAL_S; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [paused, router]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <header className="app-topbar">
      <button
        className="btn btn-ghost btn-sm px-2 md:hidden"
        onClick={onOpenMobileNav}
        aria-label={t("nav.open")}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <CommandPalette />
      <div className="topbar-primary">
        <div className="topbar-basis"><BasisSwitch /></div>
        <button
          className="sync-control"
          onClick={() => setPaused((p) => !p)}
          title={paused ? t("shell.autoRefreshResume") : t("shell.autoRefreshPause")}
          aria-label={paused ? t("shell.autoRefreshResume") : t("shell.autoRefreshPause")}
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: paused ? "var(--text-muted)" : "var(--st-normal-fg)" }} />
          <span className="hidden lg:inline">
            {paused
              ? t("shell.refreshPaused")
              : t("shell.refreshIn").replace("{seconds}", `${left}`)}
          </span>
        </button>
        <button className="btn btn-sm topbar-refresh" onClick={refresh}>{t("action.refresh")}</button>

        <details className="account-menu">
          <summary className="account-trigger" aria-label={t("shell.account")}>
            <span>{userName}</span>
            <small>{roleLabel}</small>
          </summary>
          <div className="account-popover">
            <div className="account-identity">
              <strong>{userName}</strong>
              <span>{roleLabel}</span>
            </div>
            <div className="account-basis">
              <span className="eyebrow">{t("basis.label")}</span>
              <BasisSwitch />
            </div>
            <div className="account-row">
              <span>{t("shell.language")}</span>
              <LangSwitch />
            </div>
            <div className="account-row">
              <span>{t("shell.theme")}</span>
              <ThemeToggle />
            </div>
            <button className="btn btn-ghost btn-sm account-logout" onClick={logout}>
              {t("action.logout")}
            </button>
          </div>
        </details>
      </div>
    </header>
  );
}
