import { NextResponse } from "next/server";
import { historyDbExists, stateQuery } from "@/lib/db";
import { getSyncHealth } from "@/lib/queries";
import { getThresholds, getRules, getRecipients, getWarehouses, getCapacity } from "@/lib/config";
import { sessionSecretStatus } from "@/lib/session-secret";

export async function GET() {
  const checks: Record<string, unknown> = { history_db: historyDbExists() };
  const session = sessionSecretStatus();
  checks.authentication = session.configured
    ? { status: "ok", source: session.source }
    : { status: "error", reason: session.reason, required: "SESSION_SECRET or AUTH_SECRET" };
  try {
    getThresholds(); getRules(); getRecipients(); getWarehouses(); getCapacity();
    checks.config = "ok";
  } catch (e) {
    checks.config = `error: ${(e as Error).message}`;
  }
  if (checks.history_db) {
    try {
      const h = await getSyncHealth();
      checks.last_snapshot = h.last_snapshot;
      checks.snapshot_rows = h.snapshot_rows;
      if (h.last_snapshot) {
        const ageMin = Math.round((Date.now() - +new Date(h.last_snapshot)) / 60000);
        checks.snapshot_age_minutes = ageMin;
        checks.snapshot_fresh = ageMin <= 30;
      }
    } catch (e) {
      checks.history_query = `error: ${(e as Error).message}`;
    }
  }
  try {
    await stateQuery("SELECT 1 AS ok");
    checks.state_db = "ok";
  } catch (e) {
    checks.state_db = `error: ${(e as Error).message}`;
  }
  const healthy = checks.history_db === true
    && session.configured
    && checks.config === "ok"
    && checks.state_db === "ok"
    && checks.snapshot_fresh === true;
  return NextResponse.json(
    { status: healthy ? "ok" : "degraded", checks },
    { status: healthy ? 200 : 503 }
  );
}
