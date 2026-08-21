"use client";
import { useEffect, useState } from "react";

/**
 * Nomor urut yang berubah setiap tema diganti.
 *
 * Chart.js membaca warnanya sekali, saat grafik dibuat. Tanpa langganan ini,
 * berpindah ke tema gelap meninggalkan sumbu dan garis kisi dengan warna tema
 * terang sampai halaman dimuat ulang — abu-abu pucat di atas permukaan gelap.
 *
 * Sinyalnya memakai pola yang sudah dipakai aplikasi ini untuk basis tampilan
 * (`wiom:basis`) dan bahasa (`wiom:language`), sehingga hanya ada satu cara
 * memberi tahu komponen klien bahwa preferensi tampilan berubah.
 */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((current) => current + 1);
    window.addEventListener("wiom:theme", bump);
    return () => window.removeEventListener("wiom:theme", bump);
  }, []);
  return version;
}
