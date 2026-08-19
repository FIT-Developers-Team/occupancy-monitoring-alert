"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, type ComponentProps, type ReactNode } from "react";

/**
 * Tautan yang memuat rute tujuannya saat pengguna menunjukkan niat, bukan saat
 * halaman ini digambar.
 *
 * Seluruh halaman dasbor bersifat dinamis. Prefetch bawaan Next akan menembak
 * setiap tautan yang terlihat di layar — satu kartu gudang per permintaan,
 * delapan sekaligus hanya karena halaman terbuka — jadi ia dimatikan.
 * Konsekuensinya setiap klik memulai dari nol: bundel rute, batas loading, dan
 * kueri server semuanya baru dimulai setelah tombol ditekan.
 *
 * Hover, fokus keyboard, dan sentuhan pertama semuanya mendahului navigasi
 * dengan jarak yang cukup untuk menyembunyikan pemuatan bundel rute. Ambil di
 * situ, satu kali per tujuan, dan biaya prefetch hanya dibayar untuk tautan
 * yang memang akan dibuka.
 */
export default function PrefetchLink({
  href,
  children,
  ...rest
}: Omit<ComponentProps<typeof Link>, "prefetch"> & { href: string; children: ReactNode }) {
  const router = useRouter();
  const warmed = useRef(false);
  const warm = useCallback(() => {
    if (warmed.current) return;
    warmed.current = true;
    router.prefetch(href);
  }, [href, router]);

  return (
    <Link
      {...rest}
      href={href}
      prefetch={false}
      onMouseEnter={warm}
      onFocus={warm}
      onTouchStart={warm}
    >
      {children}
    </Link>
  );
}
