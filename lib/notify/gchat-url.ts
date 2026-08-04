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

/** Accept either a bare numeric Chat user ID, users/<id>, or the all alias. */
export function normalizeGoogleChatMentionId(value: string): string | null {
  const cleaned = value.trim().replace(/^users\//i, "");
  if (cleaned.toLowerCase() === "all") return "all";
  return /^\d{6,30}$/.test(cleaned) ? cleaned : null;
}

export function normalizeGoogleChatMentionIds(values: string[]): string[] {
  return [...new Set(values.map(normalizeGoogleChatMentionId).filter((v): v is string => Boolean(v)))];
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
