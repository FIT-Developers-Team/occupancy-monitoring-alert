import { NextRequest, NextResponse } from "next/server";
import { submitSignup } from "@/lib/account-store";
import { consumeRateLimit, requestKey } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  const rate = consumeRateLimit(requestKey(request.headers, "signup"), {
    limit: 8,
    windowMs: 15 * 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Terlalu banyak percobaan. Coba lagi beberapa saat." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Data pendaftaran tidak valid." }, { status: 400 });
  const password = String(body.password ?? "");
  if (password !== String(body.confirmPassword ?? "")) {
    return NextResponse.json({ error: "Konfirmasi password tidak sama." }, { status: 400 });
  }
  try {
    const account = await submitSignup({
      name: String(body.name ?? ""),
      username: String(body.username ?? ""),
      email: String(body.email ?? ""),
      password,
    });
    return NextResponse.json({ ok: true, status: account.status }, { status: 201 });
  } catch (error) {
    const message = (error as Error).message;
    return NextResponse.json(
      { error: message },
      { status: /ditutup/i.test(message) ? 403 : 400 },
    );
  }
}
