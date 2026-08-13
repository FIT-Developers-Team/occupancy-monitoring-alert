import { NextRequest, NextResponse } from "next/server";
import { setSignupEnabled } from "@/lib/account-store";
import { currentUser, isAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";

export async function PUT(request: NextRequest) {
  const user = await currentUser();
  if (!user || !isAdmin(user.role)) return NextResponse.json({ error: "Khusus admin." }, { status: 403 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "Status pendaftaran tidak valid." }, { status: 400 });
  }
  const settings = await setSignupEnabled(body.enabled, user.username);
  await audit(user.username, "SIGNUP_GATE_UPDATE", "auth:signup", undefined, {
    signup_enabled: settings.signup_enabled,
  });
  return NextResponse.json({ settings });
}
