// Pilihan filter pergerakan: gudang, kategori, tipe produk, status, operator,
// dan daftar aksi mentah beserta tipe kanoniknya.
//
// Terpisah dari /api/movements dengan alasan yang sama seperti facet SLOC:
// isinya berubah jauh lebih jarang daripada tabel, dan tidak perlu ikut
// ditarik ulang pada setiap ketikan di kotak pencarian.
import { NextResponse } from "next/server";
import { getMovementFacets } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getMovementFacets());
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
