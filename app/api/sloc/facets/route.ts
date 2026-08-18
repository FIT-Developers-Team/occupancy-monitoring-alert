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

export async function GET() {
  try {
    return NextResponse.json(await getSlocFacets());
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
