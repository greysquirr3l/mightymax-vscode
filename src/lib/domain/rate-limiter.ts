/**
 * Per-key request pacing (pure).
 *
 * A token bucket holding up to `requestsPerMinute` tokens, refilled
 * continuously. `reserve` always grants a slot but reports how long the
 * caller must wait before using it, so a burst of parallel turns is
 * spread out instead of tripping the platform's 429. Reservations are
 * made in order, so waits stack rather than collide.
 *
 * `requestsPerMinute <= 0` disables pacing.
 */
export class RequestRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Milliseconds the caller must wait before sending a request for `keyId`. */
  reserve(keyId: string, requestsPerMinute: number): number {
    if (!(requestsPerMinute > 0)) return 0;
    const now = this.now();
    const perMs = requestsPerMinute / 60_000;
    const bucket = this.buckets.get(keyId) ?? { tokens: requestsPerMinute, at: now };
    // Refill, capped at one minute's worth of requests.
    bucket.tokens = Math.min(requestsPerMinute, bucket.tokens + (now - bucket.at) * perMs);
    bucket.at = now;
    // Spend a token; a negative balance is the debt the caller waits out.
    bucket.tokens -= 1;
    this.buckets.set(keyId, bucket);
    return bucket.tokens >= 0 ? 0 : Math.ceil(-bucket.tokens / perMs);
  }
}
