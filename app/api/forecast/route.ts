import { NextResponse } from "next/server";
import { getForecastRows } from "@/lib/queries";

export async function GET() {
  try {
    return NextResponse.json({ rows: await getForecastRows() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
