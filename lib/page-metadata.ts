import type { Metadata } from "next";
import { getT } from "@/lib/i18n";

/**
 * Judul tab per halaman, mengikuti bahasa yang dipilih pengguna.
 *
 * Sebelumnya setiap halaman memakai satu judul yang sama, sehingga sepuluh tab
 * dasbor yang terbuka bersamaan — cara kerja yang wajar saat membandingkan
 * gudang — tampak identik di bilah tab dan di riwayat browser. Judulnya diambil
 * dari label navigasi yang sama, jadi nama di sidebar dan nama di tab tidak
 * pernah berbeda.
 */
export function pageTitle(key: string, fallback?: string) {
  return async function generateMetadata(): Promise<Metadata> {
    const t = await getT();
    return { title: t(key, fallback) };
  };
}
