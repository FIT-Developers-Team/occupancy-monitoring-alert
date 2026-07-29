// Runtime-safe session-secret validation. This module intentionally has no
// Node-only imports so it can also be used by Edge middleware.
const EXAMPLE_SECRET = /^(change-me|dev-only|example|your-|replace-|todo)/i;

export function configuredSessionSecret(): string | undefined {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 32 || EXAMPLE_SECRET.test(secret)) return undefined;
  return secret;
}

export function hasProductionSessionSecret(): boolean {
  return Boolean(configuredSessionSecret());
}
