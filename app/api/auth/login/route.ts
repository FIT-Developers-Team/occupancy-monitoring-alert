import { NextRequest, NextResponse } from "next/server";
import { verifyPassword, createSessionToken, SESSION_COOKIE } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  SESSION_SECRET_ENV_NAMES,
  sessionSecretStatus,
} from "@/lib/session-secret";
import { clearRateLimit, consumeRateLimit, requestKey } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  const secret = sessionSecretStatus();
  if (process.env.NODE_ENV === "production" && !secret.configured) {
    return NextResponse.json({
      error: "Secret sesi server belum dikonfigurasi dengan aman.",
      code: "SESSION_SECRET_NOT_CONFIGURED",
      reason: secret.reason,
      acceptedEnvironmentVariables: SESSION_SECRET_ENV_NAMES,
    }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const { username, password } = await req.json().catch(() => ({}));
  if (!username || !password) {
    return NextResponse.json({ error: "Username dan password wajib diisi." }, { status: 400 });
  }
  const rateKey = requestKey(req.headers, "login", String(username));
  const rate = consumeRateLimit(rateKey, { limit: 10, windowMs: 15 * 60_000 });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Terlalu banyak percobaan login. Coba lagi beberapa saat." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }
  const user = verifyPassword(String(username), String(password));
  if (!user) {
    return NextResponse.json({ error: "Username atau password salah." }, { status: 401 });
  }
  clearRateLimit(rateKey);
  const token = await createSessionToken(user);
  const res = NextResponse.json({ ok: true, user });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12,
    secure: process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "1",
  });
  await audit(user.username, "LOGIN", "session");
  return res;
}
