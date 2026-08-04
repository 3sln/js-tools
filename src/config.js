// The shape of a project's build, and its defaults.
//
// One config drives both the builder and the dev server. That is the point:
// the two disagreeing about which files are project modules, which packages are
// dependencies, or where an entry point lives is exactly the class of bug that
// only shows up after a deploy.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail, posix } from './util.js';
import { DEFAULT_WIREUP_PATH } from './wireup.js';

// Identity, but it gives an editor something to complete against and gives a
// config file somewhere obvious to import from.
export const defineConfig = (config) => config;

export const CONFIG_FILES = ['jstools.config.js', 'jstools.config.mjs'];

export async function loadConfig({ root = process.cwd(), file = null } = {}) {
  const candidates = file ? [isAbsolute(file) ? file : join(root, file)]
    : CONFIG_FILES.map((f) => join(root, f));
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    fail(`No config found. Looked for ${candidates.join(', ')}.`);
  }
  const mod = await import(pathToFileURL(found).href);
  const config = mod.default ?? mod.config;
  if (!config) fail(`${found} does not default-export a config.`);
  return normalise({ root, ...config });
}

export function normalise(config = {}) {
  const root = resolve(config.root ?? process.cwd());
  const abs = (p) => (isAbsolute(p) ? p : join(root, p));

  const src = abs(config.src ?? 'src');
  const out = abs(config.out ?? 'dist');
  const assetRoot = posix(String(config.assetRoot ?? 'assets')).replace(/^\/|\/$/g, '');

  const entries = config.entries ?? {};
  if (Object.keys(entries).length === 0) {
    fail('At least one entry is required: entries: {app: {module: "main.js"}}.');
  }
  for (const [name, entry] of Object.entries(entries)) {
    if (!entry?.module) fail(`Entry "${name}" has no module.`);
  }

  const packageJsonPath = abs(config.packageJson ?? 'package.json');
  if (!existsSync(packageJsonPath)) fail(`No package.json at ${packageJsonPath}.`);
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

  return {
    root,
    src,
    out,
    assetRoot,
    // Under the asset root, so the one immutable rule covers it too.
    vendorDir: posix(config.vendorDir ?? `${assetRoot}/vendor`).replace(/^\/|\/$/g, ''),

    // Which subdirectories of `src` hold shippable modules. Null means all of
    // it. A worker or server directory sitting under the same src belongs in
    // `exclude` or outside `include` -- it is not client code and must not be
    // published to the asset tree.
    include: config.include ?? null,
    exclude: (config.exclude ?? []).map(posix),
    extensions: config.extensions ?? ['.js'],

    entries,
    // Where dependencies are read from and resolved from. A repository whose
    // client has its own package.json (donki's app/) points both at it.
    packageJson: packageJsonPath,
    modulesFrom: abs(config.modulesFrom ?? dirname(packageJsonPath)),
    dependencies: config.dependencies ?? Object.keys(pkg.dependencies || {}),

    minify: config.minify ?? false,
    minifyVendor: config.minifyVendor ?? true,
    minifyCss: config.minifyCss ?? true,
    target: config.target ?? 'es2022',

    // The URL a page carries before the build rewrites it, and the URL the dev
    // server answers on.
    wireupPath: config.wireupPath ?? DEFAULT_WIREUP_PATH,

    // Files and directories copied through untouched: `{from, to}` relative to
    // root and out. Their paths are returned so a headers file can list them.
    copy: config.copy ?? [],
    // HTML files rewritten so their wire-up tag points at the hashed script:
    // `{from, to}`, or a bare string for both.
    html: (config.html ?? []).map((h) => (typeof h === 'string' ? { from: h, to: h } : h)),

    // A JS module the server side of the project can import. Null to skip.
    manifest: config.manifest === null ? null : abs(config.manifest ?? 'dist/client-manifest.js'),

    clean: config.clean ?? true,
    quiet: config.quiet ?? false,
  };
}
