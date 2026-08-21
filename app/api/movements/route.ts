// Sumber data tabel "Recent movements": filter, agregasi, dan paginasi
// dikerjakan DuckDB.
//
// Satu permintaan mengembalikan tabel DAN angka ringkasannya. Memisahkannya
// menjadi beberapa permintaan berarti kartu KPI dan tabel di bawahnya sempat
// menampilkan dua potongan filter yang berbeda pada saat filter diubah — dan
// pada laporan pergerakan stok, dua angka yang tak konsisten dalam satu layar
// jauh lebih merugikan daripada satu tarikan yang sedikit lebih besar.
import { NextRequest, NextResponse } from "next/server";
import { getWarehouses } from "@/lib/config";
import { parseMovementFilter } from "@/lib/movements";
import {
  getMovementActivity,
  getMovementByWarehouse,
  getMovementRows,
  getMovementSummary,
  MOVEMENT_PAGE_MAX,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const filter = parseMovementFilter(params);
  if (filter.wh && !getWarehouses().warehouses.some((warehouse) => warehouse.code === filter.wh)) {
    return NextResponse.json({ error: "Warehouse tidak dikenal." }, { status: 400 });
  }
  const include = new Set((params.get("include") ?? "").split(",").map((v) => v.trim()));
  const offset = Number(params.get("offset") ?? 0);
  const limit = Math.min(MOVEMENT_PAGE_MAX, Number(params.get("limit") ?? 100) || 100);

  try {
    const [rows, summary, activity, warehouses] = await Promise.all([
      getMovementRows(filter, offset, limit),
      getMovementSummary(filter),
      include.has("activity") ? getMovementActivity(filter) : Promise.resolve([]),
      include.has("warehouses") ? getMovementByWarehouse(filter) : Promise.resolve([]),
    ]);
    return NextResponse.json({ rows, summary, activity, warehouses, filter });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
