import { NextRequest, NextResponse } from "next/server";
import {
  getHeatmapPage,
  getHeatmapPreviews,
  getSlocOccupancy,
  getZoneSummary,
} from "@/lib/queries";
import { getWarehouses } from "@/lib/config";

/**
 * Snapshot sumber di-refresh paling cepat setiap sepuluh menit, dan read model
 * server sendiri berumur lima menit. Cache privat 45 detik karenanya tidak
 * pernah menampilkan data yang lebih lama daripada yang sudah dilayani server,
 * tetapi membuat gerakan bolak-balik antar gudang dan buka-tutup dialog zona
 * terasa seketika alih-alih memicu pemindaian DuckDB baru setiap kali.
 */
const HEATMAP_CACHE = "private, max-age=45, stale-while-revalidate=180";

export async function GET(req: NextRequest) {
  const wh = (req.nextUrl.searchParams.get("wh") || "PGS").trim().toUpperCase();
  const valid = getWarehouses().warehouses.some((w) => w.code === wh);
  if (!valid) return NextResponse.json({ error: "Warehouse tidak dikenal." }, { status: 400 });
  const cached = { headers: { "Cache-Control": HEATMAP_CACHE } };
  try {
    const sloc = req.nextUrl.searchParams.get("sloc")?.trim().toUpperCase();
    if (sloc) {
      const [cell] = await getSlocOccupancy({ wh, sloc, operational: true });
      return NextResponse.json({ warehouse: wh, cell: cell ?? null }, cached);
    }
    if (req.nextUrl.searchParams.get("summary") === "1") {
      if (req.nextUrl.searchParams.get("preview") === "1") {
        const [zones, previews] = await Promise.all([getZoneSummary(wh), getHeatmapPreviews(wh, 24)]);
        return NextResponse.json({ warehouse: wh, zones, previews }, cached);
      }
      return NextResponse.json({ warehouse: wh, zones: await getZoneSummary(wh) }, cached);
    }
    const zone = req.nextUrl.searchParams.get("zone")?.trim().toUpperCase();
    if (!zone) return NextResponse.json({ error: "zone wajib diisi." }, { status: 400 });
    const rackZone = req.nextUrl.searchParams.get("rackZone")?.trim().toUpperCase() ?? "";
    const offset = Number(req.nextUrl.searchParams.get("offset") || 0);
    const limit = Number(req.nextUrl.searchParams.get("limit") || 600);
    return NextResponse.json({
      warehouse: wh,
      zone,
      rackZone,
      ...(await getHeatmapPage(wh, zone, rackZone, offset, limit)),
    }, cached);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
