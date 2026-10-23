// Small Python behaviours that check.js needs to match check.py exactly.

/** Python's round(): halves go to the even neighbour. */
export function pyRound(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Python's repr() of a str. */
export function pyStrRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  const body = s.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('\t', '\\t');
  return q + (q === "'" ? body.replaceAll("'", "\\'") : body) + q;
}

/** Python's repr() of a list of str. */
export function pyListRepr(list) {
  return '[' + list.map(pyStrRepr).join(', ') + ']';
}

const LINE_BREAKS = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/** Python's str.splitlines(). */
export function splitlines(s) {
  if (s === '') return [];
  const parts = s.split(LINE_BREAKS);
  if (LINE_BREAKS.test(s.slice(-1))) parts.pop();
  return parts;
}

/** Python's str.strip(chars). */
export function pyStrip(s, chars) {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}
