// Katalog SKU untuk editor Standar CBM.
//
// Daftar SKU tidak dapat dikirim seluruhnya seperti daftar zona atau kategori:
// jumlahnya ribuan dan berubah setiap sinkronisasi. Pencarian di sisi server
// mengembalikan sekaligus jejak SKU pada snapshot terakhir — berapa lokasi,
// berapa unit, dan berapa volume menurut sumber data — sehingga admin dapat
// menilai apakah sebuah SKU layak diberi standar sendiri sebelum mengetik
// angkanya.
import { NextRequest, NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { searchSkuCatalog } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hasilnya hanya berubah ketika snapshot stok berganti — sekali per sepuluh
 * menit — sedangkan pengetikan memicunya beberapa kali per detik.
 */
const CACHE = "private, max-age=60, stale-while-revalidate=300";

export async function GET(request: NextRequest) {
  const user = await currentUser();
  if (!user || !isAdmin(user.role)) {
    return NextResponse.json({ error: "Khusus admin." }, { status: 403, headers: { "cache-control": "no-store" } });
  }
  const params = request.nextUrl.searchParams;
  const query = (params.get("q") ?? "").slice(0, 80);
  const skus = (params.get("skus") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const limit = Number(params.get("limit") ?? 30);
  try {
    const result = await searchSkuCatalog({
      query,
      skus,
      limit: Number.isFinite(limit) ? limit : 30,
    });
    return NextResponse.json(result, { headers: { "cache-control": CACHE } });
  } catch (error) {
    // Katalog adalah bantuan pencarian, bukan syarat menyimpan: snapshot yang
    // belum ada tidak boleh membuat editor tampak rusak.
    return NextResponse.json(
      { error: (error as Error).message, rows: [], total: 0 },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }
}
