const buckets = new Map<string, { count: number; resetAt: number }>();

/**
 * In-memory fixed-window limiter. Good enough for a single-instance Railway
 * deployment; move to a shared store (e.g. Postgres/Redis) if this app ever
 * runs multiple instances.
 */
export function isRateLimited(
  key: string,
  { max, windowMs }: { max: number; windowMs: number },
): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }

  bucket.count += 1;
  return bucket.count > max;
}
