// Small shared helpers. Nothing here knows what a build is.
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, statSync, writeFileSync, cpSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// A build failure is a thrown BuildError rather than a process.exit, so the
// builder can be called from a script that wants to do something else first --
// and so the tests can assert on it.
export class BuildError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BuildError';
  }
}

export const fail = (message) => {
  throw new BuildError(message);
};

// Ten hex characters of sha-256. Long enough that a collision is not a thing
// that happens, short enough to read in a network panel.
export const shortHash = (buf, length = 10) =>
  createHash('sha256').update(buf).digest('hex').slice(0, length);

// Percent-encodes each path segment. Scoped package names carry an `@`, and an
// asset server normalises that to %40 with a 307 -- one extra round trip per
// module on every cold load. Writing the encoded form is what the redirect was
// asking for anyway.
export const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

// URLs are posix even where paths are not.
export const posix = (p) => p.split('\\').join('/');

export function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === '.DS_Store') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function writeFileAt(dest, contents) {
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, contents);
  return dest;
}

export function copyInto(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

// A stable, order-independent digest of a set of strings -- what a build id is
// made of, so that a build which emits the same files gets the same id no
// matter what order the filesystem handed them over in.
export const digestOf = (values) =>
  shortHash(Buffer.from(JSON.stringify([...values].sort())));
