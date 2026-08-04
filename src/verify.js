// Does every specifier in the shipped graph resolve?
//
// This exists because of a silent one: jszip states its browser entry as a
// *map* of redirects rather than a filename, the entry-point reader handed the
// map itself over as a path, nothing resolved, and the package quietly vanished
// from the import map. The build was green. The failure was a blank page at
// runtime, in the one code path that lazily imported it.
//
// So the graph is walked before the build reports success. esbuild does the
// walking -- it is already here, and it is a real parser, so this covers
// dynamic imports and re-exports without a regex guessing at JavaScript. Every
// bare specifier is intercepted: in the map, it resolves as external and
// esbuild goes no further; not in the map, and it is an error naming the file
// that imported it.
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { fail, posix } from './util.js';

// A specifier that is not relative and not absolute -- so, a package.
const BARE = /^[^./]/;

export async function verifyGraph({ root, src, entries, imports, allow = [] }) {
  const mapped = new Set(Object.keys(imports).filter((k) => BARE.test(k)));
  const prefixes = [...mapped].filter((k) => k.endsWith('/'));
  const allowed = new Set(allow);

  const resolvable = (path) =>
    mapped.has(path)
    || allowed.has(path)
    || path.startsWith('node:')
    || prefixes.some((p) => path.startsWith(p));

  const missing = new Map(); // specifier -> importers

  const check = {
    name: '3sln-check-specifiers',
    setup(builder) {
      builder.onResolve({ filter: BARE }, (args) => {
        if (!resolvable(args.path)) {
          const importer = posix(args.importer.replace(root, '').replace(/^\//, ''));
          missing.set(args.path, [...(missing.get(args.path) ?? []), importer]);
        }
        // External either way: the point is to walk the project's own modules,
        // not to bundle a dependency that the build already handled.
        return { path: args.path, external: true };
      });
    },
  };

  await esbuild.build({
    entryPoints: Object.values(entries).map((e) => join(src, e.module)),
    bundle: true,
    write: false,
    // Nothing is written, but esbuild still insists on somewhere to put more
    // than one entry point's output before it will agree to discard it.
    outdir: join(root, '.3sln-verify'),
    metafile: false,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
    absWorkingDir: root,
    plugins: [check],
  });

  if (missing.size) {
    const lines = [...missing].map(
      ([specifier, importers]) => `  ${specifier} — imported by ${[...new Set(importers)].join(', ')}`,
    );
    fail(
      `${missing.size} specifier(s) in the shipped graph are not in the import map:\n${lines.join('\n')}\n` +
      'A dependency reaches the map through `dependencies` in package.json and an `exports` entry ' +
      'the resolver understands. If one of these is deliberately provided elsewhere, list it in `allowUnresolved`.',
    );
  }
}
