import { NextResponse } from "next/server";
import { getSignupSettings } from "@/lib/account-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = getSignupSettings();
  return NextResponse.json(
    { signupEnabled: settings.signup_enabled },
    { headers: { "Cache-Control": "no-store" } },
  );
}
