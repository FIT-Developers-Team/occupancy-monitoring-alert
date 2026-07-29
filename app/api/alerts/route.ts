import { NextRequest, NextResponse } from "next/server";
import { listAlerts } from "@/lib/alerts/store";
import type { Severity } from "@/types";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  try {
    const alerts = await listAlerts({
      status: sp.get("status")?.split(",").filter(Boolean),
      severity: (sp.get("severity") as Severity) || undefined,
      warehouse: sp.get("warehouse") || undefined,
      rule: sp.get("rule") || undefined,
      limit: Number(sp.get("limit") || 200),
    });
    return NextResponse.json({ alerts });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
