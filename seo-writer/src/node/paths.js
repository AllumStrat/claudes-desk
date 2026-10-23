// Where the CLI may write: only inside the --out folder.

import { isAbsolute, relative, resolve } from 'node:path';

/** The full path for name inside dir; throws if it would land anywhere else. */
export function outPath(dir, name) {
  const root = resolve(dir);
  const target = resolve(root, name);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Refusing to write ${target}: it is outside the out folder ${root}.`);
  return target;
}
