import { NextRequest, NextResponse } from "next/server";
import { searchData } from "@/lib/queries";

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (q.length < 2) return NextResponse.json({ slocs: [], products: [] });
  try {
    return NextResponse.json(await searchData(q));
  } catch {
    return NextResponse.json({ slocs: [], products: [] });
  }
}
