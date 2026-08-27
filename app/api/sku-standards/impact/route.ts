// Berapa volume yang berubah bila standar yang sedang diedit disimpan.
//
// Mengubah standar CBM sebuah SKU menggeser PEMBILANG setiap rasio volume di
// aplikasi ini. Tanpa angka ini, satu-satunya cara mengetahui seberapa besar
// pergeserannya adalah menyimpan lebih dulu lalu membandingkan layar sebelum
// dan sesudah — pada data produksi, dengan alert yang ikut berjalan.
import { NextRequest, NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { MAX_SKU_STANDARDS } from "@/lib/config-schema";
import { skuStandardImpact } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

interface IncomingStandard { sku?: unknown; unit_cbm?: unknown }

export async function POST(request: NextRequest) {
  const user = await currentUser();
  if (!user || !isAdmin(user.role)) {
    return NextResponse.json({ error: "Khusus admin." }, { status: 403, headers: NO_STORE });
  }
  const body = await request.json().catch(() => null) as { standards?: IncomingStandard[] } | null;
  const incoming = Array.isArray(body?.standards) ? body.standards : null;
  if (!incoming) {
    return NextResponse.json({ error: "Body JSON tidak valid." }, { status: 400, headers: NO_STORE });
  }
  if (incoming.length > MAX_SKU_STANDARDS) {
    return NextResponse.json(
      { error: `Terlalu banyak standar untuk dipratinjau (maksimum ${MAX_SKU_STANDARDS}).` },
      { status: 400, headers: NO_STORE },
    );
  }
  const standards = incoming
    .map((entry) => ({
      sku: typeof entry.sku === "string" ? entry.sku : "",
      unit_cbm: typeof entry.unit_cbm === "number" ? entry.unit_cbm : Number.NaN,
    }))
    .filter((entry) => entry.sku && Number.isFinite(entry.unit_cbm));
  try {
    return NextResponse.json(await skuStandardImpact(standards), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 200, headers: NO_STORE });
  }
}
