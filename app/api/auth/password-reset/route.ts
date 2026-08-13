import { NextRequest, NextResponse } from "next/server";
import { requestPasswordReset } from "@/lib/account-store";
import { consumeRateLimit, requestKey } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const username = String(body?.username ?? "");
  const rate = consumeRateLimit(requestKey(request.headers, "password-reset", username), {
    limit: 5,
    windowMs: 30 * 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Terlalu banyak permintaan. Coba lagi nanti." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }
  await requestPasswordReset(username, String(body?.email ?? ""));
  // Deliberately identical for matches and misses to avoid exposing which
  // usernames or work emails exist in the system.
  return NextResponse.json({
    ok: true,
    message: "Jika data cocok, permintaan reset akan tampil di panel Admin.",
  });
}
