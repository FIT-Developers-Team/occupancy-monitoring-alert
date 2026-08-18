// Sumber data tabel SLOC interaktif: filter + pencarian dikerjakan DuckDB,
// bukan disaring di browser, agar 143 ribu lokasi tetap dapat ditelusuri tanpa
// mengirim seluruhnya ke klien.
import { NextRequest, NextResponse } from "next/server";
import { getWarehouses } from "@/lib/config";
import { parseSlocFilter } from "@/lib/sloc-filter";
import { getSlocExplorerPage } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const filter = parseSlocFilter(params);
  if (filter.wh && !getWarehouses().warehouses.some((warehouse) => warehouse.code === filter.wh)) {
    return NextResponse.json({ error: "Warehouse tidak dikenal." }, { status: 400 });
  }
  try {
    // Pilihan filter dilayani /api/sloc/facets: daftar zona berubah jauh lebih
    // jarang daripada isi tabel dan tidak perlu ikut setiap ketikan pencarian.
    const page = await getSlocExplorerPage(
      filter,
      Number(params.get("offset") ?? 0),
      Number(params.get("limit") ?? 100),
    );
    return NextResponse.json({ ...page, filter });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
