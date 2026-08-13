// Worker entry points.
//
// A worker gets no import map. That is the whole reason this exists, and it is
// easy to learn the hard way: the map is a property of the *document*, so a
// worker module resolves every specifier itself. A bare `@scope/pkg` fails, and
// so does a neighbour like `./align.js` -- it resolves to the unhashed path,
// which under content addressing is a key the map rewrites and not a file that
// exists. The worker 404s before it runs a line.
//
// Worse, it works in development, where modules are served at their unhashed
// paths and the relative import happens to resolve. So the failure appears only
// after a deploy, which is the class of bug this package exists to prevent.
//
// A worker is therefore bundled whole -- dependencies inlined, no splitting, no
// shared chunks -- so it depends on nothing it cannot resolve on its own. It
// cannot share the page's vendor chunks in any case: a worker has its own module
// graph, and a second copy of a library is the price of running off the main
// thread.
import { createHash } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';
import * as esbuild from 'esbuild';
import { posix, writeFileAt } from './util.js';

/**
 * @returns {Map<string, {rel: string, hashed: string}>} name -> source path and
 *   the content-addressed file emitted for it, both relative to the asset root.
 */
export async function bundleWorkers({ src, workers, outDir, minify, target, absWorkingDir }) {
  const emitted = new Map();
  for (const [name, modulePath] of Object.entries(workers ?? {})) {
    const rel = posix(modulePath);
    const built = await esbuild.build({
      entryPoints: [join(src, rel)],
      bundle: true,
      // Splitting would emit chunks the worker fetches by relative URL. They
      // would resolve, but a worker that carries its own graph has nothing to
      // share them with, so it buys nothing and adds requests.
      splitting: false,
      format: 'esm',
      platform: 'browser',
      target,
      minify,
      write: false,
      absWorkingDir,
      logLevel: 'warning',
    });
    const code = Buffer.from(built.outputFiles[0].contents);
    const hash = createHash('sha256').update(code).digest('hex').slice(0, 10);
    const dir = posix(dirname(rel));
    const stem = basename(rel, extname(rel));
    const hashed = posix(dir === '.' ? `${stem}.${hash}.js` : `${dir}/${stem}.${hash}.js`);
    writeFileAt(join(outDir, hashed), code);
    emitted.set(name, { rel, hashed });
  }
  return emitted;
}
