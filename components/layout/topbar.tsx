"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import ThemeToggle from "@/components/ui/theme-toggle";
import CommandPalette from "@/components/ui/command-palette";
import BasisSwitch from "@/components/ui/basis-switch";
import LangSwitch from "@/components/ui/lang-switch";
import { useT } from "@/lib/i18n-client";
import { localeOf } from "@/lib/i18n-dict";

// Halaman dimuat ulang saat snapshot benar-benar berganti (lihat pemungutan
// status di bawah), jadi timer ini bukan lagi cara utama layar tetap segar —
// ia jaring pengaman untuk keadaan di mana sinyal versi tidak pernah tiba,
// misalnya endpoint status tak dapat dihubungi dari tab ini.
const FALLBACK_REFRESH_MS = 600_000;
// Indikator sinkronisasi sekaligus pembawa sinyal "ada snapshot baru".
const STATUS_POLL_MS = 60_000;

interface DataStatus {
  state: string;
  updatedAt?: string | null;
  workerOnline: boolean;
  hasSnapshot: boolean;
  dataVersion?: string | null;
}

export default function Topbar({
  userName, role, dataVersion, warehouses, onOpenMobileNav,
}: {
  userName: string; role: string; dataVersion: string;
  warehouses: string[]; onOpenMobileNav: () => void;
}) {
  const router = useRouter();
  const { t, lang } = useT();
  const [paused, setPaused] = useState(false);
  const [dataStatus, setDataStatus] = useState<DataStatus | null>(null);
  const nextRefresh = useRef(Date.now() + FALLBACK_REFRESH_MS);
  const roleLabel = t(`shell.role.${role}`, role);

  // Snapshot yang menghasilkan HTML yang sedang tampil. Prop-nya ikut berubah
  // setiap kali server merender ulang, sehingga patokan ini menyusul sendiri
  // begitu sebuah refresh benar-benar terpasang.
  const renderedVersion = useRef(dataVersion);
  // Versi yang sudah pernah memicu refresh dari tab ini. Tanpa penanda ini,
  // satu refresh yang gagal membawa data baru akan diulang tiap pemungutan.
  const requestedVersion = useRef<string | null>(null);
  // Dibaca dari dalam pemungut yang hanya dipasang sekali, jadi keduanya harus
  // lewat ref: menaruhnya di daftar dependensi akan membongkar-pasang interval
  // 60 detik itu setiap kali tombol jeda ditekan.
  const pausedRef = useRef(paused);
  const refreshRef = useRef<() => void>(() => {});

  const refresh = useCallback(() => {
    router.refresh();
    nextRefresh.current = Date.now() + FALLBACK_REFRESH_MS;
  }, [router]);

  useEffect(() => { renderedVersion.current = dataVersion; }, [dataVersion]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  useEffect(() => {
    if (paused) return undefined;
    nextRefresh.current = Date.now() + FALLBACK_REFRESH_MS;
    const refreshIfDue = () => {
      if (!document.hidden && Date.now() >= nextRefresh.current) refresh();
    };
    const timer = window.setInterval(refreshIfDue, FALLBACK_REFRESH_MS);
    document.addEventListener("visibilitychange", refreshIfDue);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshIfDue);
    };
  }, [paused, refresh]);

  // Indikator sinkronisasi hanya berarti bagi mata yang sedang melihatnya.
  // Sebelumnya ia tetap memanggil endpoint tiap menit di setiap tab latar yang
  // dibiarkan terbuka seharian — pekerjaan server yang tidak pernah terlihat
  // siapa pun. Pemungutan berhenti saat tab tersembunyi dan langsung menyusul
  // sekali begitu tab kembali aktif, sehingga yang dilihat pengguna saat
  // kembali tetap kondisi terkini.
  //
  // Jawaban yang sama juga memberi tahu versi snapshot yang berlaku, dan itu
  // sudah tiba tiap 60 detik. Sebelumnya kabar itu dibiarkan lewat: halaman
  // menunggu timer sepuluh menitnya sendiri meski sudah tahu ada data baru.
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const read = async () => {
      if (document.hidden) return;
      try {
        const response = await fetch("/api/data-status", {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = (await response.json()) as DataStatus;
        if (!active) return;
        setDataStatus(body);

        const version = typeof body?.dataVersion === "string" ? body.dataVersion : null;
        if (
          version
          && !pausedRef.current
          && version !== renderedVersion.current
          && version !== requestedVersion.current
        ) {
          // Satu refresh per versi per tab. Pemungutan berikutnya tidak
          // mengulanginya, dan patokan di atas ikut bergeser sendiri begitu
          // server selesai merender snapshot yang baru.
          requestedVersion.current = version;
          refreshRef.current();
        }
      } catch (error) {
        if (active && (error as { name?: string })?.name !== "AbortError") setDataStatus(null);
      }
    };
    void read();
    const timer = window.setInterval(read, STATUS_POLL_MS);
    document.addEventListener("visibilitychange", read);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  const syncBusy = dataStatus?.state === "queued" || dataStatus?.state === "running";
  const syncAttention = dataStatus?.state === "failed" || (dataStatus && !dataStatus.workerOnline);
  const syncLabel = syncBusy
    ? t("shell.sync.running")
    : syncAttention
      ? t("shell.sync.lastValid")
      : paused
        ? t("shell.refreshPaused")
        : t("shell.sync.current");
  // Jam sinkronisasi mengikuti bahasa yang dipilih, seperti setiap tanggal lain
  // di aplikasi ini; zona waktunya tetap WIB karena itulah waktu operasional.
  const syncTitle = dataStatus?.updatedAt
    ? `${syncLabel} · ${new Date(dataStatus.updatedAt).toLocaleString(localeOf(lang), { timeZone: "Asia/Jakarta" })} WIB`
    : syncLabel;

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
      <CommandPalette role={role} warehouses={warehouses} />
      <div className="topbar-primary">
        <div className="topbar-basis"><BasisSwitch /></div>
        <button
          className="sync-control"
          onClick={() => setPaused((p) => !p)}
          title={`${syncTitle} · ${paused ? t("shell.autoRefreshResume") : t("shell.autoRefreshPause")}`}
          aria-label={paused ? t("shell.autoRefreshResume") : t("shell.autoRefreshPause")}
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: syncAttention ? "var(--st-warning-fg)" : paused ? "var(--text-muted)" : "var(--st-normal-fg)" }} />
          <span className="hidden lg:inline">
            {syncLabel}
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
