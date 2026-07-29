// Runtime-safe session-secret validation. This module intentionally has no
// Node-only imports so it can also be used by Edge middleware.
const EXAMPLE_SECRET = /^(change-me|dev-only|example|generate-|your-|replace-|todo)/i;

export const SESSION_SECRET_ENV_NAMES = [
  "SESSION_SECRET",
  "AUTH_SECRET",
  "NEXTAUTH_SECRET",
] as const;

export type SessionSecretStatus =
  | { configured: true; source: (typeof SESSION_SECRET_ENV_NAMES)[number] }
  | {
      configured: false;
      source?: (typeof SESSION_SECRET_ENV_NAMES)[number];
      reason: "missing" | "too_short" | "placeholder";
    };

function unquote(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  return quoted ? trimmed.slice(1, -1).trim() : trimmed;
}

function candidates() {
  // Keep these accesses explicit. Next.js can then expose the same runtime
  // variables consistently to Node routes and Edge middleware.
  return [
    ["SESSION_SECRET", unquote(process.env.SESSION_SECRET)],
    ["AUTH_SECRET", unquote(process.env.AUTH_SECRET)],
    ["NEXTAUTH_SECRET", unquote(process.env.NEXTAUTH_SECRET)],
  ] as const;
}

function isValid(secret: string | undefined): secret is string {
  return Boolean(secret && secret.length >= 32 && !EXAMPLE_SECRET.test(secret));
}

export function configuredSessionSecret(): string | undefined {
  return candidates().find(([, value]) => isValid(value))?.[1];
}

export function sessionSecretStatus(): SessionSecretStatus {
  const values = candidates();
  const valid = values.find(([, value]) => isValid(value));
  if (valid) return { configured: true, source: valid[0] };

  const present = values.find(([, value]) => Boolean(value));
  if (!present) return { configured: false, reason: "missing" };
  return {
    configured: false,
    source: present[0],
    reason: EXAMPLE_SECRET.test(present[1] || "") ? "placeholder" : "too_short",
  };
}

export function hasProductionSessionSecret(): boolean {
  return sessionSecretStatus().configured;
}
