// Fixed-window counters kept in the database, so every server instance
// shares them (unlike in-memory limits, which reset per Worker isolate).

export function createDbLimiter(db, now = () => Date.now()) {
  return {
    // Counts one hit and says whether it is within the limit.
    async hit(key, limit, windowMs) {
      const t = now();
      const window = Math.floor(t / windowMs) * windowMs; // window start, ms
      const row = await db
        .prepare(
          'INSERT INTO counters (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count',
        )
        .bind(key, window)
        .first();
      const count = row?.count ?? 1;
      const retryAfterSec = Math.max(1, Math.ceil((window + windowMs - t) / 1000));
      return { allowed: count <= limit, count, retryAfterSec };
    },
  };
}
