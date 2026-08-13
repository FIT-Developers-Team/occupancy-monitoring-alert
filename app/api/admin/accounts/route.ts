import { NextRequest, NextResponse } from "next/server";
import { createAccount, getSignupSettings, listAccounts } from "@/lib/account-store";
import { currentUser, isAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import type { Role } from "@/types";

export const dynamic = "force-dynamic";

async function adminUser() {
  const user = await currentUser();
  return user && isAdmin(user.role) ? user : null;
}

export async function GET() {
  const user = await adminUser();
  if (!user) return NextResponse.json({ error: "Khusus admin." }, { status: 403 });
  return NextResponse.json({ accounts: listAccounts(), settings: getSignupSettings() }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: NextRequest) {
  const user = await adminUser();
  if (!user) return NextResponse.json({ error: "Khusus admin." }, { status: 403 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Data akun tidak valid." }, { status: 400 });
  const role = body.role === "admin" ? "admin" : "supervisor";
  try {
    const account = await createAccount({
      name: String(body.name ?? ""),
      username: String(body.username ?? ""),
      email: String(body.email ?? ""),
      password: String(body.password ?? ""),
      role: role as Role,
    }, user.username);
    await audit(user.username, "ACCOUNT_CREATE", `account:${account.username}`, undefined, {
      role: account.role, status: account.status, email: account.email,
    });
    return NextResponse.json({ account }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
