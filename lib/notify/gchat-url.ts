const GOOGLE_CHAT_HOST = "chat.googleapis.com";
const GOOGLE_CHAT_PATH = /^\/v1\/spaces\/[^/]+\/messages$/;

/** Incoming-webhook URL only; reject arbitrary hosts before the server performs a POST. */
export function isGoogleChatWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === GOOGLE_CHAT_HOST
      && GOOGLE_CHAT_PATH.test(url.pathname)
      && Boolean(url.searchParams.get("key"))
      && Boolean(url.searchParams.get("token"));
  } catch {
    return false;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalise one mention target.
 *
 * Work email is the primary form because that is what warehouse admins know —
 * nobody can look up a numeric Chat user ID for their supervisor. Numeric IDs
 * and the `all` alias stay accepted so existing routes keep working.
 *
 * Whether `<users/{email}>` resolves into a real ping is decided by Google Chat
 * against the sending Workspace; use the route's test-send to confirm it.
 */
export function normalizeGoogleChatMentionId(value: string): string | null {
  const cleaned = value.trim().replace(/^users\//i, "");
  if (!cleaned) return null;
  if (cleaned.toLowerCase() === "all") return "all";
  if (EMAIL.test(cleaned)) return cleaned.toLowerCase();
  return /^\d{6,30}$/.test(cleaned) ? cleaned : null;
}

export function normalizeGoogleChatMentionIds(values: string[]): string[] {
  return [...new Set(values.map(normalizeGoogleChatMentionId).filter((v): v is string => Boolean(v)))];
}

/** Mention targets that are addresses, for the human-readable PIC line. */
export function mentionEmailsOf(values: string[]): string[] {
  return normalizeGoogleChatMentionIds(values).filter((value) => EMAIL.test(value));
}

const THREAD_NAME = /^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_-]+$/;

/** Space id a webhook posts into, used to check a thread belongs to it. */
export function googleChatSpaceOf(webhookUrl: string): string | null {
  try {
    return new URL(webhookUrl).pathname.match(/\/spaces\/([^/]+)\/messages$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resource name of an existing thread: `spaces/<space>/threads/<thread>`.
 *
 * Copy it from the thread URL in Google Chat. Posting into a thread that lives
 * in a different Space than the webhook silently fails, so callers should also
 * compare against googleChatSpaceOf().
 */
export function normalizeGoogleChatThreadName(value: string): string | null {
  const cleaned = value.trim();
  return THREAD_NAME.test(cleaned) ? cleaned : null;
}

/** Never persist or show the webhook key/token in notification logs. */
export function redactGoogleChatWebhook(value: string): string {
  try {
    const url = new URL(value);
    const space = url.pathname.match(/\/spaces\/([^/]+)/)?.[1] ?? "unknown";
    return `${url.hostname}/spaces/${space}`;
  } catch {
    return "google-chat-webhook";
  }
}
