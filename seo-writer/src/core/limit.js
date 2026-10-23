// Bounded concurrency for the writer's fetches, so one request never opens
// more than a few connections at a time.

/** Runs fn over items with at most n calls in flight; results keep the input order. */
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

/** Wraps an async function so at most n calls of it run at once. */
export function limited(fn, n) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active--;
    if (waiting.length) waiting.shift()();
  };
  return async (...args) => {
    if (active >= n) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn(...args);
    } finally {
      release();
    }
  };
}
