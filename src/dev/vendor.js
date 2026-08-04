// Dependencies in development.
//
// The build bundles every dependency. Development does not, where it can avoid
// it: a package that is already an ES module is served straight out of
// node_modules, so what the browser shows in a stack trace is the file on disk
// and a `bun link`ed dependency is edited and reloaded like any other source.
//
// What cannot be served that way is a package that is not an ES module. The
// browser has no `require`, so those are run through esbuild into ESM and
// cached. They are bundled *together*, with splitting, for the same reason the
// build does it -- two independent bundles of two subpaths of one package are
// two copies of that package -- and every directly-served ESM specifier is
// marked external, so a converted package reaches its ESM dependencies through
// the import map rather than inlining a second copy of them.
import { statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { collectEntryPoints, isEsm, readPackage } from '../entry-points.js';
import { bundleVendor } from '../vendor.js';
import { digestOf, encodePath, posix } from '../util.js';

export const VENDOR_PREFIX = '/@vendor/';

export function vendorGraph(config) {
  const { root, modulesFrom, dependencies, target } = config;
  const cacheDir = join(root, 'node_modules', '.cache', '3sln-js-tools', 'vendor');
  let state = null;

  // A URL for a file that lives under the served root. Anything outside it --
  // a dependency resolved through a symlink to somewhere else on the disk --
  // has no URL here, and gets bundled instead.
  const urlUnderRoot = (abs) => {
    const rel = posix(relative(root, abs));
    return rel && !rel.startsWith('..') ? `/${encodePath(rel)}` : null;
  };

  const stamp = (file) => {
    try {
      return String(statSync(file).mtimeMs);
    } catch {
      return '0';
    }
  };

  async function ensure() {
    const entries = collectEntryPoints({
      from: modulesFrom,
      dependencies,
      // Nothing is bundled here, so a bare specifier inside a dependency's own
      // source has to be in the map too, or the browser cannot resolve it.
      recursive: true,
      wildcards: true,
    });

    const imports = {};
    const bundled = [];

    for (const entry of entries) {
      if (entry.wildcard) {
        const url = urlUnderRoot(entry.dir);
        if (url) imports[entry.specifier] = `${url}/`;
        continue;
      }
      const url = urlUnderRoot(entry.file);
      if (url && isEsm(readPackage(entry.pkgDir), entry.file)) {
        imports[entry.specifier] = url;
      } else {
        bundled.push(entry);
      }
    }

    // Rebuilt when a converted package changes on disk, so a linked dependency
    // being worked on does not need the server restarted.
    const key = digestOf(bundled.map((e) => `${e.specifier}@${e.version}:${stamp(e.file)}`));
    if (state && state.key === key) {
      return { ...state, imports: { ...imports, ...state.bundledImports } };
    }

    const bundledImports = {};
    if (bundled.length) {
      const { urlFor } = await bundleVendor({
        entries: bundled,
        outdir: cacheDir,
        outRoot: cacheDir,
        absWorkingDir: root,
        minify: false,
        sourcemap: 'inline',
        target,
        hashNames: false,
        // Reached through the import map instead of inlined, so there is still
        // exactly one copy of each ESM package in the page.
        external: Object.keys(imports).map((s) => (s.endsWith('/') ? `${s}*` : s)),
      });
      for (const [specifier, href] of urlFor) {
        bundledImports[specifier] = posix(join(VENDOR_PREFIX, href));
      }
    }

    state = { key, bundledImports, cacheDir, converted: bundled.map((e) => e.specifier) };
    return { ...state, imports: { ...imports, ...bundledImports } };
  }

  return { ensure, cacheDir };
}
