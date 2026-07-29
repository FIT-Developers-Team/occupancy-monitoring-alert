import { NextResponse } from "next/server";
import { getIntegrity, getIntegrityDrift } from "@/lib/queries";

export async function GET() {
  try {
    const [summary, drift] = await Promise.all([getIntegrity(), getIntegrityDrift(30)]);
    return NextResponse.json({ summary, drift });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
