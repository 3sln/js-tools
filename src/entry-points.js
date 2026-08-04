// Turning a dependency into a set of module entry points.
//
// The unit is a *specifier*, not a file: "@3sln/dodo" and "@3sln/dodo/reactive"
// are two entry points into one package, and both the builder and the dev
// server need to know all of them. They are read from the package's `exports`
// rather than a hand-kept list, so adding a subpath to a dependency needs no
// change anywhere here.
//
// Deep imports are deliberately unsupported. A wildcard subpath ("./src/*")
// cannot become a build entry point without enumerating what it might match,
// and giving a package's internals their own entry points would hand out a
// second copy of the package -- which is the one thing this whole arrangement
// exists to prevent. The dev server, where nothing is bundled and a second copy
// is not a risk, maps a wildcard to a directory prefix instead.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fail } from './util.js';

// Which condition of a conditional export to follow. Browser first: these
// entry points are for a browser, and a package that ships a browser build
// usually does so because the default one reaches for node.
const CONDITIONS = ['browser', 'import', 'module', 'default'];

export function targetOf(entry, conditions = CONDITIONS) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return null;
  for (const c of conditions) {
    const hit = entry[c];
    if (typeof hit === 'string') return hit;
    // Conditions nest: {"browser": {"import": "./x.js"}}.
    if (hit && typeof hit === 'object') {
      const inner = targetOf(hit, conditions);
      if (inner) return inner;
    }
  }
  return null;
}

// A package without `exports` states its browser entry in `browser`, which is
// how (for instance) jszip redirects ./lib/index -- which pulls in node's
// stream -- to a prebuilt browser bundle. A bundler applies this to resolutions
// it makes itself, but an entry point handed over as an absolute path never
// goes through resolution, so it has to be applied here.
export function browserRedirect(pkg, file) {
  const b = pkg.browser;
  if (typeof b === 'string') return b;
  if (!b || typeof b !== 'object') return file;
  const norm = (s) => String(s).replace(/^\.\//, '').replace(/\.js$/, '');
  const hit = Object.entries(b).find(([k, v]) => norm(k) === norm(file) && typeof v === 'string');
  return hit ? hit[1] : file;
}

// `main` may omit the extension, or name a directory ("./lib").
function resolveFile(dir, file) {
  const base = join(dir, String(file).replace(/^\.\//, ''));
  if (existsSync(base) && statSync(base).isFile()) return base;
  return [`${base}.js`, `${base}.mjs`, join(base, 'index.js')].find((c) => existsSync(c)) ?? null;
}

// node's own resolution, minus the parts that do not apply: walk up from a
// starting directory looking for node_modules/<name>. This is what makes a
// dependency of a dependency findable whether the installer hoisted it or not.
export function resolvePackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function readPackage(pkgDir) {
  return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
}

// Is this file already an ES module?
//
// Only the dev server asks, and only so it can decide between serving the file
// as it is and running it through esbuild first. The bias is deliberate: when
// the answer is not obvious, say no. Converting a module that did not need it
// costs a little startup time; serving a CommonJS file as ESM is a hard failure
// in the browser with an error that points at the wrong thing.
export function isEsm(pkg, file) {
  const ext = extname(file);
  if (ext === '.mjs') return true;
  if (ext === '.cjs') return false;
  if (pkg.type === 'module') return true;

  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const cjs = /(^|[^.\w])(require\s*\(|module\.exports|exports\.[A-Za-z_$])/.test(src);
  if (cjs) return false;
  return /(^|[\n;])\s*(import\s+[\w{*'"]|import\s*\(|export\s+(default|const|let|var|function|class|\{|\*))/.test(src);
}

// Every entry point a single package publishes.
//
//   {specifier, file, pkgDir, pkgName, version, wildcard}
//
// `wildcard` entries carry a directory rather than a file and are only ever
// returned when asked for.
export function entryPointsFor(name, { from, wildcards = false } = {}) {
  const pkgDir = resolvePackageDir(name, from);
  if (!pkgDir) return [];
  const pkg = readPackage(pkgDir);
  const found = [];

  const add = (specifier, file) => {
    const abs = resolveFile(pkgDir, file);
    if (abs) found.push({ specifier, file: abs, pkgDir, pkgName: name, version: pkg.version ?? '0.0.0' });
  };

  if (!pkg.exports) {
    add(name, browserRedirect(pkg, pkg.browser || pkg.module || pkg.main || 'index.js'));
    return found;
  }
  if (typeof pkg.exports === 'string') {
    add(name, pkg.exports);
    return found;
  }

  for (const [key, entry] of Object.entries(pkg.exports)) {
    if (key === './package.json') continue;
    const target = targetOf(entry);
    if (!target) continue;

    if (key.includes('*')) {
      if (!wildcards || !key.startsWith('./')) continue;
      // "./src/*": "./src/*" becomes a trailing-slash prefix mapping, which is
      // exactly what an import map means by one.
      const prefix = key.slice(2).replace(/\*.*$/, '');
      const dir = target.replace(/^\.\//, '').replace(/\*.*$/, '');
      found.push({
        specifier: `${name}/${prefix}`,
        dir: join(pkgDir, dir).replace(/[/\\]+$/, ''),
        wildcard: true,
        pkgDir,
        pkgName: name,
        version: pkg.version ?? '0.0.0',
      });
      continue;
    }
    add(key === '.' ? name : `${name}/${key.slice(2)}`, target);
  }
  return found;
}

// Entry points for a whole dependency list.
//
// `recursive` follows each dependency's own dependencies. The builder does not
// need it -- esbuild resolves what it bundles. The dev server does: nothing is
// bundled there, so a bare specifier inside a dependency's own source has to be
// in the import map or the browser cannot resolve it.
export function collectEntryPoints({ from, dependencies, recursive = false, wildcards = false }) {
  const out = [];
  const seen = new Set();

  const visit = (names, searchFrom) => {
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      const points = entryPointsFor(name, { from: searchFrom, wildcards });
      if (points.length === 0) continue;
      out.push(...points);
      if (!recursive) continue;
      const { pkgDir } = points[0];
      const deps = Object.keys(readPackage(pkgDir).dependencies || {});
      if (deps.length) visit(deps, pkgDir);
    }
  };

  visit(dependencies, from);
  if (out.length === 0) {
    fail(
      `No dependency entry points found. Looked for [${dependencies.join(', ')}] from ${from} ` +
      '-- has anything been installed there?',
    );
  }
  return out;
}

// esbuild names an output after its entry *file*, so two subpaths that happen
// to share a basename ("index.js") would collide. Key each by its specifier.
export const safeName = (specifier) => specifier.replace(/^@/, '').replace(/\//g, '_');
