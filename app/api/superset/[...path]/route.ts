// Proxy tipis ke Superset internal (pola cookie-auth v5.5) — untuk kebutuhan
// ad-hoc dari dashboard tanpa mengekspos cookie ke browser. Khusus admin.
import { NextRequest, NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const user = await currentUser();
  if (!user || !isAdmin(user.role)) {
    return NextResponse.json({ error: "Khusus admin." }, { status: 403 });
  }
  const base = process.env.SUPERSET_BASE_URL;
  const cookie = process.env.SUPERSET_SESSION_COOKIE;
  if (!base) {
    return NextResponse.json({ error: "SUPERSET_BASE_URL belum di-set." }, { status: 503 });
  }
  const { path } = await ctx.params;
  const url = new URL(`${base.replace(/\/$/, "")}/${path.join("/")}`);
  req.nextUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));

  const headers: Record<string, string> = { Accept: "application/json" };
  if (cookie) headers.Cookie = `session=${cookie}`;
  const csrf = req.headers.get("x-csrftoken");
  if (csrf) { headers["X-CSRFToken"] = csrf; headers.Referer = base; }

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    headers["Content-Type"] = req.headers.get("content-type") || "application/json";
    init.body = await req.text();
  }
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("content-type") || "application/json" },
    });
  } catch (e) {
    return NextResponse.json({ error: `Superset tidak terjangkau: ${(e as Error).message}` }, { status: 502 });
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) { return proxy(req, ctx); }
export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) { return proxy(req, ctx); }
