"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n-client";

export type NavMode = "open" | "rail";

const NAV = [
  { href: "/", key: "nav.exec", icon: "M3 13h4v8H3zM10 9h4v12h-4zM17 3h4v18h-4z" },
  { href: "/occupancy", key: "nav.occupancy", icon: "M4 4h16v6H4zM4 14h9v6H4zM16 14h4v6h-4z" },
  { href: "/heatmap", key: "nav.heatmap", icon: "M4 4h4v4H4zM10 4h4v4h-4zM16 4h4v4h-4zM4 10h4v4H4zM10 10h4v4h-4zM16 10h4v4h-4zM4 16h4v4H4zM10 16h4v4h-4zM16 16h4v4h-4z" },
  { href: "/forecast", key: "nav.forecast", icon: "M3 17l6-6 4 4 8-8M15 7h6v6" },
  { href: "/density", key: "nav.density", icon: "M12 3l9 16H3l9-16zM12 10v4M12 17v.5" },
  { href: "/alerts", key: "nav.alerts", icon: "M12 3a6 6 0 016 6v3l2 3H4l2-3V9a6 6 0 016-6zM10 19a2 2 0 004 0" },
  { href: "/integrity", key: "nav.integrity", icon: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM8.5 12l2.5 2.5 4.5-4.5" },
  { href: "/audit", key: "nav.audit", icon: "M6 3h9l4 4v14H6zM14 3v5h5M9 12h6M9 16h6" },
  { href: "/guide", key: "nav.guide", icon: "M4 5a2 2 0 012-2h6v18H6a2 2 0 01-2-2V5zM12 3h6a2 2 0 012 2v14a2 2 0 01-2 2h-6M8 8h1M8 12h1" },
  { href: "/settings", key: "nav.settings", icon: "M12 8a4 4 0 100 8 4 4 0 000-8zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4" },
];

const Logo = ({ withText }: { withText: boolean }) => (
  <span className="flex items-center gap-2.5">
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <rect width="32" height="32" rx="7" fill="#0F172A" />
      <rect x="6" y="6" width="8" height="8" rx="1.5" fill="#3C83F6" />
      <rect x="18" y="6" width="8" height="8" rx="1.5" fill="#14B8A6" />
      <rect x="6" y="18" width="8" height="8" rx="1.5" fill="#14B8A6" opacity="0.55" />
      <rect x="18" y="18" width="8" height="8" rx="1.5" fill="#EA580C" />
    </svg>
    {withText && (
      <span className="leading-tight">
        <span className="block font-semibold text-[13px]" style={{ fontFamily: "var(--font-display)" }}>WIOM</span>
        <span className="eyebrow block" style={{ fontSize: 9 }}>Control Tower</span>
      </span>
    )}
  </span>
);

export default function Sidebar({
  mode, mobileOpen, onNavigate, onToggle,
}: { mode: NavMode; mobileOpen: boolean; onNavigate: () => void; onToggle: () => void }) {
  const pathname = usePathname();
  const { t } = useT();
  const rail = mode === "rail";

  return (
    <aside
      className={[
        "z-40 flex flex-col border-r",
        // mobile: drawer penuh
        "fixed inset-y-0 left-0 w-60 transition-transform duration-200 ease-out",
        mobileOpen ? "translate-x-0" : "-translate-x-full",
        // desktop: kolom sticky, lebar animasi open⇄rail
        "md:sticky md:top-0 md:h-screen md:translate-x-0 md:transition-[width] md:duration-200",
        rail ? "md:w-[60px]" : "md:w-56",
      ].join(" ")}
      style={{ borderColor: "var(--border)", background: "var(--surface-raised)", overflow: "hidden" }}
    >
      {/* Konten mobile selalu penuh; desktop mengikuti mode */}
      <div className="flex h-full w-60 flex-col px-3 py-4 md:w-auto md:px-2">
        <div className={`flex items-center pb-4 ${rail ? "md:flex-col md:gap-2" : "justify-between"}`}>
          <Link href="/" onClick={onNavigate} className={rail ? "md:px-0 px-2" : "px-2"}
            aria-label="WIOM Control Tower">
            <span className="md:hidden"><Logo withText /></span>
            <span className="hidden md:block"><Logo withText={!rail} /></span>
          </Link>
          <button
            onClick={onToggle}
            className="hidden md:grid h-7 w-7 place-items-center rounded-md transition-colors hover:bg-[var(--surface-sunken)]"
            style={{ color: "var(--text-muted)" }}
            title={rail ? t("nav.expand") : t("nav.collapse")}
            aria-label={rail ? t("nav.expand") : t("nav.collapse")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={`transition-transform duration-200 ${rail ? "rotate-180" : ""}`} aria-hidden>
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
        </div>

        <nav className="flex flex-col gap-0.5">
          {NAV.map((n) => {
            const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} onClick={onNavigate} title={t(n.key)}
                className={`navlink ${active ? "active" : ""} ${rail ? "md:justify-center md:px-0" : ""}`}>
                <svg className="navicon shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d={n.icon} />
                </svg>
                <span className={rail ? "md:hidden" : ""}>{t(n.key)}</span>
              </Link>
            );
          })}
        </nav>

        <div className={`mt-auto px-2 pt-3 text-[10.5px] ${rail ? "md:hidden" : ""}`}
          style={{ color: "var(--text-muted)" }}>
          <div className="eyebrow mb-1">FIT · Astro</div>
          {t("shell.phase")}
        </div>
      </div>
    </aside>
  );
}
