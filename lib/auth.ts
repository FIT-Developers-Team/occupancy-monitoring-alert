// Session auth: HMAC-signed cookie via Web Crypto (works in Node routes AND
// edge middleware), users + scrypt hashes from config/users.json.
import { scryptSync, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import type { Role, SessionUser } from "@/types";
import { configuredSessionSecret } from "@/lib/session-secret";
import { findActiveAccount } from "@/lib/account-store";

const SECRET = configuredSessionSecret()
  || (process.env.NODE_ENV !== "production" ? "dev-only-secret-change-me" : undefined);
export const SESSION_COOKIE = "wiom_session";
const MAX_AGE_S = 60 * 60 * 12; // 12 jam shift-friendly

export function verifyPassword(username: string, password: string): SessionUser | null {
  const u = findActiveAccount(username);
  if (!u) return null;
  const calc = scryptSync(password, u.salt, 32).toString("hex");
  const ok =
    calc.length === u.scrypt.length &&
    timingSafeEqual(Buffer.from(calc, "hex"), Buffer.from(u.scrypt, "hex"));
  return ok ? {
    username: u.username,
    role: u.role,
    name: u.name,
    sessionVersion: u.session_version,
  } : null;
}

const enc = new TextEncoder();
async function hmac(data: string): Promise<string> {
  if (!SECRET) throw new Error("SESSION_SECRET wajib diisi pada production.");
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Buffer.from(sig).toString("base64url");
}

export async function createSessionToken(user: SessionUser): Promise<string> {
  const payload = Buffer.from(
    JSON.stringify({ ...user, exp: Date.now() + MAX_AGE_S * 1000 })
  ).toString("base64url");
  return `${payload}.${await hmac(payload)}`;
}

export async function verifySessionToken(token: string | undefined): Promise<SessionUser | null> {
  if (!SECRET || !token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if ((await hmac(payload)) !== sig) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (data.exp < Date.now()) return null;
    if (
      typeof data.username !== "string"
      || (data.role !== "admin" && data.role !== "supervisor")
      || typeof data.name !== "string"
      || typeof data.sessionVersion !== "number"
    ) return null;
    return {
      username: data.username,
      role: data.role,
      name: data.name,
      sessionVersion: data.sessionVersion,
    };
  } catch {
    return null;
  }
}

export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const session = await verifySessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  const account = findActiveAccount(session.username);
  if (!account || account.session_version !== session.sessionVersion) return null;
  return {
    username: account.username,
    role: account.role,
    name: account.name,
    sessionVersion: account.session_version,
  };
}

export async function requireUser(): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) throw new Error("UNAUTHORIZED");
  return u;
}

export function canWrite(role: Role): boolean {
  return role === "admin" || role === "supervisor";
}
export function isAdmin(role: Role): boolean {
  return role === "admin";
}
