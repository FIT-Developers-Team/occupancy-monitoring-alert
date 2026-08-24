"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n-client";

export default function ThemeToggle() {
  const { t } = useT();
  const [dark, setDark] = useState(false);

  /**
   * Tombol ini BUKAN satu-satunya yang mengganti tema.
   *
   * Command palette punya aksinya sendiri, dan ia menyalakan kelas `dark` di
   * elemen root langsung. Selama komponen ini hanya membaca kelas itu sekali
   * saat dipasang, mengganti tema lewat palette membuat ikon dan labelnya
   * terbalik: bulan pada tema gelap, "Ganti ke tema Graphite" padahal sudah
   * gelap. Karena itu ia berlangganan sinyal yang sama yang sudah dipakai
   * grafik — satu sumber kebenaran, dibaca ulang dari DOM setiap kali tema
   * benar-benar berubah, dari mana pun perubahannya berasal.
   */
  useEffect(() => {
    const sync = () => setDark(document.documentElement.classList.contains("dark"));
    sync();
    window.addEventListener("wiom:theme", sync);
    return () => window.removeEventListener("wiom:theme", sync);
  }, []);

  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("wiom-theme", next ? "dark" : "light"); } catch {}
    // Grafik melukis ke canvas dan tidak dapat mengikuti `var(--…)` seperti sisa
    // aplikasi, jadi mereka perlu diberi tahu. Pola sinyalnya sama dengan
    // `wiom:basis` dan `wiom:language`. Sinyal ini juga yang menyetel `dark` di
    // atas, jadi keadaan tombol tidak pernah ditulis di dua tempat.
    window.dispatchEvent(new Event("wiom:theme"));
  }
  const label = dark ? t("shell.themeToLight") : t("shell.themeToDark");
  return (
    <button className="btn btn-ghost btn-sm" onClick={toggle} aria-label={label} title={label}>
      {dark ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <circle cx="12" cy="12" r="4.5" /><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.5 4.5l1.8 1.8M17.7 17.7l1.8 1.8M19.5 4.5l-1.8 1.8M6.3 17.7l-1.8 1.8" strokeLinecap="round" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}
