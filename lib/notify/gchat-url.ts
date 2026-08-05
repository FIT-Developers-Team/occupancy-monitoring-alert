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
  // `email=123456789012` pins the address to a Chat user ID. Chat only turns a
  // numeric ID into a real ping, so this is the form that reliably notifies
  // while the address stays visible to whoever reads the card.
  const paired = cleaned.match(/^(.+?)\s*=\s*(\d{6,30})$/);
  if (paired && EMAIL.test(paired[1].trim())) return `${paired[1].trim().toLowerCase()}=${paired[2]}`;
  if (EMAIL.test(cleaned)) return cleaned.toLowerCase();
  return /^\d{6,30}$/.test(cleaned) ? cleaned : null;
}

export function normalizeGoogleChatMentionIds(values: string[]): string[] {
  return [...new Set(values.map(normalizeGoogleChatMentionId).filter((v): v is string => Boolean(v)))];
}

/** What Chat should receive inside `<users/…>` for one normalised target. */
export function mentionPingIdOf(value: string): string {
  const paired = value.match(/^(.+?)=(\d{6,30})$/);
  return paired ? paired[2] : value;
}

/** Mention targets that carry an address, for the human-readable PIC line. */
export function mentionEmailsOf(values: string[]): string[] {
  return normalizeGoogleChatMentionIds(values)
    .map((value) => value.match(/^(.+?)=\d{6,30}$/)?.[1] ?? value)
    .filter((value) => EMAIL.test(value));
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

// What an operator actually has: the link copied from a message in the room.
//   https://chat.google.com/room/<space>/<thread>/<message>?cls=10
//   https://mail.google.com/chat/u/0/#chat/space/<space>/<thread>
const CHAT_LINK = new RegExp(
  "^https?://(?:chat\\.google\\.com/room|mail\\.google\\.com/chat/u/\\d+/#chat/space)"
  + "/([A-Za-z0-9_-]+)(?:/([A-Za-z0-9_-]+))?",
);

/**
 * Resource name of an existing thread: `spaces/<space>/threads/<thread>`.
 *
 * Accepts the room link straight from Google Chat as well, because nobody has
 * the resource name to hand — they have the "Copy link" URL. Posting into a
 * thread that lives in a different Space than the webhook silently fails, so
 * callers should also compare against googleChatSpaceOf().
 */
export function normalizeGoogleChatThreadName(value: string): string | null {
  const cleaned = value.trim();
  if (!cleaned) return null;
  if (THREAD_NAME.test(cleaned)) return cleaned;
  const link = cleaned.match(CHAT_LINK);
  return link?.[2] ? `spaces/${link[1]}/threads/${link[2]}` : null;
}

/**
 * True when the pasted link points at the room itself rather than a message
 * inside it — the most likely mistake, and one worth its own message.
 */
export function isGoogleChatSpaceOnlyLink(value: string): boolean {
  const link = value.trim().match(CHAT_LINK);
  return Boolean(link && !link[2]);
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
