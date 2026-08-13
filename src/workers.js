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
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join } from 'node:path';
import * as esbuild from 'esbuild';
import { fail, posix, writeFileAt } from './util.js';

/**
 * Where a declared worker actually is.
 *
 * Two kinds, because both exist in the wild. A project worker is a path under
 * `src`, like an entry. A dependency's worker is a specifier resolved the way
 * node would -- pdf.js, tesseract and friends ship their own, and naming one by
 * reaching into `node_modules/` with a relative path would be a lie about where
 * it comes from and would break the moment the package moved it.
 *
 * A path under `src` wins when the file is there, so a project can shadow a
 * dependency's worker by name without ceremony.
 */
function locate({ src, modulesFrom, spec, assetPath }) {
  const local = join(src, posix(spec));
  if (existsSync(local)) return { file: local, key: assetPath(posix(spec)), rel: posix(spec) };

  try {
    const require = createRequire(join(modulesFrom, 'package.json'));
    const file = require.resolve(spec);
    // Keyed by the specifier itself, exactly as a dependency's entry point is,
    // so `import.meta.resolve` answers for the name that was written.
    return { file, key: spec, rel: null };
  } catch {
    fail(
      `Worker "${spec}" is neither a file under src nor a resolvable module. ` +
      'Give a path relative to src, or a specifier node can resolve.',
    );
    return null;
  }
}

/**
 * @returns {Map<string, {key: string, rel: string|null, hashed: string}>}
 *   name -> the specifier callers resolve it by, its path under `src` when it
 *   has one, and the content-addressed file emitted for it.
 */
export async function bundleWorkers({ src, workers, outDir, minify, target, absWorkingDir, modulesFrom, assetPath }) {
  const emitted = new Map();
  for (const [name, spec] of Object.entries(workers ?? {})) {
    const found = locate({ src, modulesFrom: modulesFrom ?? src, spec, assetPath });
    const built = await esbuild.build({
      entryPoints: [found.file],
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
    // A project worker keeps its place in the tree, so the emitted file sits
    // where its source did. One from a dependency has no place in the tree, so
    // it goes under `workers/` under the name it was declared with.
    const stem = found.rel ? basename(found.rel, extname(found.rel)) : name;
    const dir = found.rel ? posix(dirname(found.rel)) : 'workers';
    const hashed = posix(dir === '.' ? `${stem}.${hash}.js` : `${dir}/${stem}.${hash}.js`);
    writeFileAt(join(outDir, hashed), code);
    emitted.set(name, { key: found.key, rel: found.rel, hashed });
  }
  return emitted;
}
