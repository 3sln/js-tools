// A whole little project on disk, written fresh for each test.
//
// Generated rather than checked in because the interesting part is
// node_modules: what the builder does with a package's `exports` is most of
// what it does, and a checked-in node_modules is both a .gitignore fight and a
// thing that rots. Writing one takes a dozen lines and says exactly what shape
// is under test.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAt } from '../src/util.js';

export function makeFixture(files = {}) {
  const root = mkdtempSync(join(tmpdir(), '3sln-js-tools-'));
  const write = (rel, contents) => writeFileAt(join(root, rel), contents);

  const base = {
    'package.json': JSON.stringify({
      name: 'fixture',
      type: 'module',
      dependencies: {
        'esm-dep': '*', 'cjs-dep': '*', 'multi-dep': '*', 'browser-dep': '*',
      },
    }),

    // An ES module with a single export, and no `exports` field at all -- the
    // legacy shape, resolved through `main`.
    'node_modules/esm-dep/package.json': JSON.stringify({
      name: 'esm-dep', version: '1.0.0', type: 'module', main: 'index.js',
    }),
    'node_modules/esm-dep/index.js': 'export const esm = "esm-dep";\n',

    // CommonJS, and `main` without an extension -- both things the resolver has
    // to cope with.
    'node_modules/cjs-dep/package.json': JSON.stringify({
      name: 'cjs-dep', version: '2.1.0', main: './lib/index',
    }),
    'node_modules/cjs-dep/lib/index.js': 'module.exports = { cjs: "cjs-dep" };\n',

    // Two subpaths over shared internals: the case splitting exists for.
    'node_modules/multi-dep/package.json': JSON.stringify({
      name: 'multi-dep',
      version: '0.3.0',
      type: 'module',
      exports: {
        '.': './index.js',
        './extra': './extra.js',
        './src/*': './src/*',
        './package.json': './package.json',
      },
    }),
    'node_modules/multi-dep/index.js':
      'import { shared } from "./shared.js";\nexport const main = shared + "-main";\n',
    'node_modules/multi-dep/extra.js':
      'import { shared } from "./shared.js";\nexport const extra = shared + "-extra";\n',
    'node_modules/multi-dep/shared.js': 'export const shared = "multi";\n',
    'node_modules/multi-dep/src/deep.js': 'export const deep = true;\n',

    // `browser` as a map of redirects rather than a filename -- jszip's shape,
    // and the one that used to make a dependency vanish from the map silently.
    'node_modules/browser-dep/package.json': JSON.stringify({
      name: 'browser-dep',
      version: '1.0.0',
      main: './lib/index',
      browser: { './lib/index': './dist/browser.js', 'readable-stream': './lib/rs-browser.js' },
    }),
    'node_modules/browser-dep/lib/index.js': 'module.exports = { node: true };\n',
    'node_modules/browser-dep/dist/browser.js': 'export const browser = "browser-dep";\n',

    'src/app/main.js': [
      'import { esm } from "esm-dep";',
      'import { helper } from "../shared/util.js";',
      'export const boot = async () => esm + helper() + (await import("multi-dep")).main;',
    ].join('\n') + '\n',
    'src/app/app.css': '@import "../shared/base.css";\nbody { color: red; }\n',
    'src/shared/util.js': 'export const helper = () => "helper";\n',
    'src/shared/base.css': ':root { --x: 1; }\n',
    'src/server/secret.js': 'export const NEVER_SHIPPED = true;\n',

    'index.html':
      '<!doctype html>\n<html><head>\n<script src="/@wireup/app.js"></script>\n</head><body></body></html>\n',
  };

  for (const [rel, contents] of Object.entries({ ...base, ...files })) {
    if (contents === null) continue;
    write(rel, contents);
  }

  return {
    root,
    write,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export const baseConfig = (root, over = {}) => ({
  root,
  src: 'src',
  include: ['app', 'shared'],
  out: 'dist',
  assetRoot: 'assets',
  entries: { app: { module: 'app/main.js', css: 'app/app.css' } },
  manifest: 'dist/manifest.js',
  quiet: true,
  ...over,
});
