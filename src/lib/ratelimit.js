'use strict';

/**
 * Fixed-window in-memory rate limiter.
 * NOTE: per-process. If you run more than one instance, back this with Redis.
 */
class RateLimiter {
  constructor({ limit, windowMs, now = () => Date.now() }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.buckets = new Map();
  }

  hit(key) {
    const t = this.now();
    if (this.buckets.size > 20000) this._sweep(t);
    let b = this.buckets.get(key);
    if (!b || t >= b.resetAt) {
      b = { count: 0, resetAt: t + this.windowMs };
      this.buckets.set(key, b);
    }
    b.count += 1;
    const ok = b.count <= this.limit;
    return { ok, remaining: Math.max(0, this.limit - b.count), retryAfterMs: ok ? 0 : b.resetAt - t };
  }

  reset(key) {
    this.buckets.delete(key);
  }

  _sweep(t) {
    for (const [k, b] of this.buckets) if (t >= b.resetAt) this.buckets.delete(k);
  }
}

module.exports = { RateLimiter };
