// Next.js Proxy: proteksi seluruh app dengan verifikasi HMAC cookie.
import { NextRequest, NextResponse } from "next/server";
import { configuredSessionSecret } from "@/lib/session-secret";
import { findActiveAccount } from "@/lib/account-store";

const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth/login",
  "/api/auth/signup",
  "/api/auth/signup-settings",
  "/api/auth/password-reset",
  "/api/live",                        // healthcheck container — wajib publik
  "/api/health",
  "/api/ready",
  "/api/cron",                        // dilindungi CRON_SECRET di handler
  "/api/notifications/telegram",      // dilindungi secret token Telegram
  "/_next",
  "/favicon.ico",
  "/icon.svg",
];

const SECRET = configuredSessionSecret()
  || (process.env.NODE_ENV !== "production" ? "dev-only-secret-change-me" : undefined);
const enc = new TextEncoder();

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verify(token: string | undefined): Promise<{ role: "admin" | "supervisor" } | null> {
  if (!SECRET || !token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  try {
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const ok = await crypto.subtle.verify(
      "HMAC", key, b64urlToBytes(sig), enc.encode(payload)
    );
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload)));
    if (typeof data.exp !== "number" || data.exp <= Date.now()) return null;
    const account = findActiveAccount(String(data.username ?? ""));
    return account && account.session_version === data.sessionVersion
      ? { role: account.role }
      : null;
  } catch {
    return null;
  }
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const user = await verify(req.cookies.get("wiom_session")?.value);
  if (user) {
    if (user.role !== "admin" && (pathname === "/settings" || pathname.startsWith("/settings/")
      || pathname === "/audit" || pathname.startsWith("/audit/"))) {
      return NextResponse.redirect(new URL("/", req.url));
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Tidak terautentikasi." }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
