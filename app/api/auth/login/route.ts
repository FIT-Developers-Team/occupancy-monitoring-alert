import { NextRequest, NextResponse } from "next/server";
import { verifyPassword, createSessionToken, SESSION_COOKIE } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { hasProductionSessionSecret } from "@/lib/session-secret";

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production" && !hasProductionSessionSecret()) {
    return NextResponse.json({
      error: "SESSION_SECRET belum dikonfigurasi dengan aman. Isi minimal 32 karakter acak pada .env, lalu restart aplikasi.",
    }, { status: 503 });
  }
  const { username, password } = await req.json().catch(() => ({}));
  if (!username || !password) {
    return NextResponse.json({ error: "Username dan password wajib diisi." }, { status: 400 });
  }
  const user = verifyPassword(String(username), String(password));
  if (!user) {
    return NextResponse.json({ error: "Username atau password salah." }, { status: 401 });
  }
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
