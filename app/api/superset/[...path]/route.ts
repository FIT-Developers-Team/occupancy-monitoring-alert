// Proxy tipis ke Superset internal (pola cookie-auth v5.5) — untuk kebutuhan
// ad-hoc dari dashboard tanpa mengekspos cookie ke browser. Khusus admin.
import { NextRequest, NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { supersetProxyFetch } from "@/lib/superset-sync";

export const runtime = "nodejs";

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const user = await currentUser();
  if (!user || !isAdmin(user.role)) {
    return NextResponse.json({ error: "Khusus admin." }, { status: 403 });
  }
  const { path } = await ctx.params;
  const search = req.nextUrl.searchParams.toString();
  const relativePath = `${path.join("/")}${search ? `?${search}` : ""}`;

  const headers: Record<string, string> = { Accept: "application/json" };
  const csrf = req.headers.get("x-csrftoken");
  if (csrf) headers["X-CSRFToken"] = csrf;

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    headers["Content-Type"] = req.headers.get("content-type") || "application/json";
    init.body = await req.text();
  }
  try {
    const res = await supersetProxyFetch(relativePath, init);
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
