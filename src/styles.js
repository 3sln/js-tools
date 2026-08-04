// Entry stylesheets: bundled, then fingerprinted.
//
// Bundled rather than mirrored because an import map does not apply to CSS. A
// hashed player.css could not resolve its own `@import '../shared/base.css'` to
// the hashed neighbour, and rewriting the @import would mean rewriting source,
// which nothing else here does. esbuild inlines them instead, so each entry is
// one file with one hash.
//
// They are also not imported from JS. An unbundled module graph has no bundler
// to turn `import './player.css'` into a stylesheet, so the wire-up script
// links them.
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { shortHash, writeFileAt } from './util.js';

export async function bundleStyles({ src, entries, outDir, minify = true, absWorkingDir }) {
  const emitted = new Map(); // entry name -> fingerprinted path, relative to outDir
  for (const [name, entry] of Object.entries(entries)) {
    if (!entry.css) continue;
    const out = await esbuild.build({
      entryPoints: [join(src, entry.css)],
      bundle: true,
      minify,
      write: false,
      logLevel: 'warning',
      absWorkingDir,
    });
    const body = Buffer.from(out.outputFiles[0].contents);
    const rel = `${name}.${shortHash(body)}.css`;
    writeFileAt(join(outDir, rel), body);
    emitted.set(name, rel);
  }
  return emitted;
}
