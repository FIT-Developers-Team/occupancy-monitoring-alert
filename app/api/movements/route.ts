import { NextRequest, NextResponse } from "next/server";
import { getRecentMovements } from "@/lib/queries";

export async function GET(req: NextRequest) {
  const sloc = req.nextUrl.searchParams.get("sloc") || undefined;
  const limit = Number(req.nextUrl.searchParams.get("limit") || 12);
  try {
    const movements = await getRecentMovements(sloc, limit);
    return NextResponse.json({ movements });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
