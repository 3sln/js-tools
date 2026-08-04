// Dependencies: bundled and split, one entry point per exported subpath.
//
// The splitting is not a size optimisation -- it is what keeps a package a
// singleton. Bundling `@3sln/dodo` and `@3sln/dodo/reactive` as two independent
// bundles would give each its own private copy of dodo's internals, and a cell
// created through one would not be recognised by the other. With splitting,
// what they share becomes a chunk they both import, so there is one copy of
// dodo in the page no matter how many of its subpaths are used.
import { basename, join, relative } from 'node:path';
import * as esbuild from 'esbuild';
import { encodePath, fail, posix } from './util.js';
import { safeName } from './entry-points.js';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function bundleVendor({
  entries,
  outdir,
  outRoot,
  absWorkingDir,
  minify = true,
  target = 'es2022',
  external = [],
  sourcemap = false,
  hashNames = true,
}) {
  const points = entries.filter((e) => !e.wildcard);
  const result = await esbuild.build({
    entryPoints: points.map((e) => ({ out: safeName(e.specifier), in: e.file })),
    outdir,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target,
    minify,
    sourcemap,
    external,
    entryNames: hashNames ? '[name]-[hash]' : '[name]',
    chunkNames: 'chunk-[hash]',
    metafile: true,
    absWorkingDir,
    logLevel: 'warning',
  });

  // Map each specifier back to the file esbuild emitted for it. The metafile
  // reports outputs relative to absWorkingDir, so they are re-based on the
  // directory the URLs are relative to.
  // Matched against the name each entry point was *given*, not by stripping a
  // suffix off the emitted filename: "cjs-dep.js" and "cjs-dep-A1B2.js" are
  // both outputs of the entry named "cjs-dep", and a regex that peels a
  // trailing "-SOMETHING" off the first one leaves "cjs".
  const urlFor = new Map();
  for (const [outFile, meta] of Object.entries(result.metafile.outputs)) {
    if (!meta.entryPoint) continue;
    const emitted = posix(relative(outRoot, join(absWorkingDir, outFile)));
    const file = basename(emitted);
    const match = points.find((e) => {
      const name = safeName(e.specifier);
      return file === `${name}.js` || new RegExp(`^${escapeRe(name)}-[A-Za-z0-9_$]+\\.js$`).test(file);
    });
    if (match) urlFor.set(match.specifier, `/${encodePath(emitted)}`);
  }

  const missing = points.filter((e) => !urlFor.has(e.specifier));
  if (missing.length) {
    fail(`Could not match built output for: ${missing.map((m) => m.specifier).join(', ')}`);
  }

  const outputs = Object.keys(result.metafile.outputs);
  return {
    urlFor,
    metafile: result.metafile,
    chunks: outputs.filter((f) => basename(f).startsWith('chunk-')).length,
    bytes: Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0),
  };
}
