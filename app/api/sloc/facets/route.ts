// Pilihan gudang/zona/rack/penyimpanan untuk dropdown filter.
//
// Endpoint terpisah dari /api/sloc/explore secara sengaja. Ketika facet ikut
// menumpang permintaan tabel yang pertama, satu permintaan yang dibatalkan —
// hal biasa saat React memasang komponen dua kali di mode pengembangan, atau
// saat pengguna mengubah filter sebelum muatan awal selesai — membuat dropdown
// tetap kosong selamanya. Daftar ini juga berubah jauh lebih jarang daripada
// isi tabel, jadi memang layak punya siklus hidupnya sendiri.
import { NextResponse } from "next/server";
import { getSlocFacets } from "@/lib/queries";

export const dynamic = "force-dynamic";

/**
 * Daftar ini hanya berubah ketika data master berubah — jauh lebih jarang
 * daripada sekali per pembukaan halaman. Cache privat singkat membuat kembali
 * ke halaman yang sama, atau memuat dua penjelajah SLOC pada satu layar, tidak
 * lagi menembus DuckDB dua kali. `stale-while-revalidate` menjaga dropdown
 * tetap terisi sementara salinan barunya diambil di belakang layar.
 */
const FACET_CACHE = "private, max-age=120, stale-while-revalidate=600";

export async function GET() {
  try {
    return NextResponse.json(await getSlocFacets(), {
      headers: { "Cache-Control": FACET_CACHE },
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
