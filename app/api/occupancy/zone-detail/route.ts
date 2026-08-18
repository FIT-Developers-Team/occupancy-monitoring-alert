import { NextRequest, NextResponse } from "next/server";
import { getWarehouses } from "@/lib/config";
import { getZoneDetail, type ZoneDetailSort } from "@/lib/queries";

const SORTS = new Set<ZoneDetailSort>([
  "sloc_code",
  "sku_number",
  "product_name",
  "qty",
  "cbm",
  "sloc_pct",
]);

export async function GET(request: NextRequest) {
  const wh = (request.nextUrl.searchParams.get("wh") ?? "").trim().toUpperCase();
  const zone = (request.nextUrl.searchParams.get("zone") ?? "").trim().toUpperCase();
  if (!getWarehouses().warehouses.some((warehouse) => warehouse.code === wh)) {
    return NextResponse.json({ error: "Warehouse tidak dikenal." }, { status: 400 });
  }
  if (!zone) return NextResponse.json({ error: "zone wajib diisi." }, { status: 400 });

  const requestedSort = request.nextUrl.searchParams.get("sort") as ZoneDetailSort | null;
  try {
    return NextResponse.json(await getZoneDetail(wh, zone, {
      offset: Number(request.nextUrl.searchParams.get("offset") ?? 0),
      limit: Number(request.nextUrl.searchParams.get("limit") ?? 100),
      query: request.nextUrl.searchParams.get("q") ?? "",
      // Nama parameter ini harus sama persis dengan yang dipakai /api/export;
      // begitu keduanya berbeda, tabel dan berkas Excel berhenti sepakat.
      status: request.nextUrl.searchParams.get("stockStatus") ?? "",
      category: request.nextUrl.searchParams.get("category") ?? "",
      rackZone: request.nextUrl.searchParams.get("rackZone") ?? "",
      sort: requestedSort && SORTS.has(requestedSort) ? requestedSort : "sloc_code",
      direction: request.nextUrl.searchParams.get("dir") === "desc" ? "desc" : "asc",
    }));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
