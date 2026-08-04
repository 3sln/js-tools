// Project modules: fingerprinted individually, never bundled.
//
// They change one at a time, and a bundle would mean every edit invalidating
// every file. Nothing is rewritten either -- import statements stay exactly as
// authored, and the import map does the redirection. That is why the source
// tree is *mirrored* under the asset root rather than hashed in place: a
// browser resolves a relative specifier to a URL before it consults the map, so
// a sibling's `../shared/stack.js` becomes `/assets/shared/stack.js`, and one
// key per module intercepts every neighbour import in the graph. One prefix
// covers the lot, which is also what lets a single `_headers` rule mark the
// whole tree immutable.
import { readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import * as esbuild from 'esbuild';
import { fail, posix, shortHash, walk, writeFileAt } from './util.js';

// Emits every module under `src` and returns the mapping from its source path
// to the fingerprinted one, both relative to `src`.
export async function emitModules({
  src,
  include = null,
  exclude = [],
  extensions = ['.js'],
  minify = false,
  target = 'es2022',
  outDir,
}) {
  const roots = include ? include.map((sub) => join(src, sub)) : [src];
  const skip = exclude.map(posix);
  const hashedOf = new Map();

  for (const root of roots) {
    for (const full of walk(root)) {
      const rel = posix(relative(src, full));
      if (rel.startsWith('..')) continue;
      if (skip.some((s) => rel === s || rel.startsWith(`${s}/`))) continue;
      const ext = extname(rel);
      if (!extensions.includes(ext)) continue;

      let body = readFileSync(full);
      if (minify && ext === '.js') {
        // Transformed, not bundled: minification renames locals and drops
        // whitespace, but every import statement survives untouched, so the
        // import map still resolves the graph module by module.
        const out = await esbuild.transform(body.toString('utf8'), {
          minify: true,
          target,
          format: 'esm',
          loader: 'js',
          sourcefile: rel,
        });
        body = Buffer.from(out.code);
      }

      const dir = dirname(rel) === '.' ? '' : `${dirname(rel)}/`;
      const hashedRel = `${dir}${basename(rel, ext)}.${shortHash(body)}${ext}`;
      hashedOf.set(rel, hashedRel);
      writeFileAt(join(outDir, hashedRel), body);
    }
  }

  if (hashedOf.size === 0) {
    fail(`No project modules found under ${src}${include ? `/{${include.join(',')}}` : ''}.`);
  }
  return hashedOf;
}
