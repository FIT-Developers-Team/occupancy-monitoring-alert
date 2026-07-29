import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { testSupersetConnection } from "@/lib/superset-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const user = await currentUser();
  if (!user || !isAdmin(user.role)) {
    return NextResponse.json({ error: "Khusus admin." }, { status: 403 });
  }
  try {
    const result = await testSupersetConnection();
    await audit(
      user.username,
      "SUPERSET_CONNECTION_TEST",
      "superset:connection",
      null,
      {
        ok: result.ok,
        latency_ms: result.latency_ms,
        identity: result.identity,
        datasets: result.datasets,
      },
    );
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (error) {
    const message = (error as Error).message;
    await audit(user.username, "SUPERSET_CONNECTION_TEST", "superset:connection", null, {
      ok: false,
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
