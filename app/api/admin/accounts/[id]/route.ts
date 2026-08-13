import { NextRequest, NextResponse } from "next/server";
import { updateAccount } from "@/lib/account-store";
import { currentUser, isAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import type { Role } from "@/types";

const ACTIONS = new Set(["approve", "reject", "disable", "activate", "reset_password", "set_role"]);

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user || !isAdmin(user.role)) return NextResponse.json({ error: "Khusus admin." }, { status: 403 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const action = String(body?.action ?? "");
  if (!ACTIONS.has(action)) return NextResponse.json({ error: "Aksi akun tidak dikenal." }, { status: 400 });
  const { id } = await context.params;
  try {
    const account = await updateAccount({
      id,
      action: action as "approve" | "reject" | "disable" | "activate" | "reset_password" | "set_role",
      actor: user.username,
      actorUsername: user.username,
      password: body?.password ? String(body.password) : undefined,
      role: body?.role === "admin" ? "admin" : body?.role === "supervisor" ? "supervisor" as Role : undefined,
    });
    await audit(user.username, `ACCOUNT_${action.toUpperCase()}`, `account:${account.username}`, undefined, {
      role: account.role, status: account.status,
    });
    return NextResponse.json({ account });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
