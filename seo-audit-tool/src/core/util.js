// Small helpers shared by the audit modules.

// Runs `fn` over `items` with at most `limit` in flight.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function clip(text, max = 160) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function listSample(items, max = 5) {
  const shown = items.slice(0, max).map((x) => clip(x, 120));
  const more = items.length > max ? ` (and ${items.length - max} more)` : '';
  return shown.join(', ') + more;
}

export function stripHash(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

const NON_HTML_EXT = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|pdf|zip|gz|rar|7z|mp3|mp4|m4a|wav|webm|mov|avi|css|js|mjs|json|xml|txt|csv|docx?|xlsx?|pptx?|woff2?|ttf|eot|otf|exe|dmg)$/i;

export function looksLikePage(u) {
  try {
    return !NON_HTML_EXT.test(new URL(u).pathname);
  } catch {
    return false;
  }
}
