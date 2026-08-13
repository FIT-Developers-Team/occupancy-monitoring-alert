interface Bucket { count: number; resetAt: number }

const buckets = new Map<string, Bucket>();

export function requestKey(headers: Headers, scope: string, subject = ""): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || headers.get("x-real-ip")?.trim() || "unknown";
  return `${scope}:${ip}:${subject.trim().toLowerCase()}`;
}

export function consumeRateLimit(
  key: string,
  options: { limit: number; windowMs: number },
): { allowed: boolean; retryAfterSeconds: number } {
  const current = Date.now();
  if (buckets.size > 2_000) {
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= current) buckets.delete(bucketKey);
    }
  }
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= current) {
    buckets.set(key, { count: 1, resetAt: current + options.windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  bucket.count += 1;
  return {
    allowed: bucket.count <= options.limit,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - current) / 1_000)),
  };
}

export function clearRateLimit(key: string): void {
  buckets.delete(key);
}
