// In-memory limits. Fine for one Node process or the local test server.
// A public deployment needs a shared store (see SECURITY.md).

export class SlidingWindowLimiter {
  constructor({ limit, windowMs, maxKeys = 10_000 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.hits = new Map();
  }

  check(key, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) || []).filter((t) => t > cutoff);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      const retryAfterSec = Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000));
      return { allowed: false, retryAfterSec, remaining: 0 };
    }
    list.push(now);
    this.hits.delete(key);
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) this.prune(now);
    return { allowed: true, retryAfterSec: 0, remaining: this.limit - list.length };
  }

  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    for (const [k, list] of this.hits) {
      if (!list.some((t) => t > cutoff)) this.hits.delete(k);
    }
    // Still too many keys: drop the oldest entries (Map keeps insertion order).
    while (this.hits.size > this.maxKeys) {
      this.hits.delete(this.hits.keys().next().value);
    }
  }
}

export class ConcurrencyGate {
  constructor(max) {
    this.max = max;
    this.active = 0;
  }

  tryEnter() {
    if (this.active >= this.max) return false;
    this.active++;
    return true;
  }

  leave() {
    this.active = Math.max(0, this.active - 1);
  }
}
