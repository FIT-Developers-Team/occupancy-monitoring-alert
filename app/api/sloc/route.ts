import { NextRequest, NextResponse } from "next/server";
import { getSlocDetail } from "@/lib/queries";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const wh = req.nextUrl.searchParams.get("wh")?.trim().toUpperCase();
  if (!code) return NextResponse.json({ error: "code wajib diisi" }, { status: 400 });
  try {
    const detail = await getSlocDetail(code, wh);
    return NextResponse.json(detail);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
