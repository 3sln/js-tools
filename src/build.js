// The build.
//
// Nothing is cache-busted here. Everything a browser keeps long-term is
// content-addressed, so a changed file is a changed URL and no invalidation is
// needed at all -- and a browser still holding a poisoned copy of an old URL
// simply never asks for it again, so it recovers on the next deploy without
// anyone clearing anything.
//
// Two treatments, because the two kinds of code have different shapes:
//
//   Dependencies are bundled and split, one entry point per subpath in the
//   package's `exports` (src/vendor.js).
//
//   Project modules are fingerprinted individually and never bundled
//   (src/modules.js).
//
// No source is rewritten either way. An import map does the redirection, and a
// wire-up script puts the map, the stylesheet and the entry module into the
// page (src/wireup.js).
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { collectEntryPoints } from './entry-points.js';
import { bundleVendor } from './vendor.js';
import { emitModules } from './modules.js';
import { bundleStyles } from './styles.js';
import { wireupHref, wireupSource } from './wireup.js';
import { normalise } from './config.js';
import {
  copyInto, digestOf, encodePath, fail, posix, shortHash, walk, writeFileAt,
} from './util.js';

export async function build(rawConfig) {
  const config = rawConfig?.__normalised ? rawConfig : { ...normalise(rawConfig), __normalised: true };
  const {
    root, src, out, assetRoot, vendorDir, include, exclude, extensions, entries,
    modulesFrom, dependencies, minify, minifyVendor, minifyCss, target,
    wireupPath, copy, html, manifest, clean, quiet,
  } = config;

  const assetDir = join(out, assetRoot);
  const url = (relFromOut) => `/${encodePath(posix(relFromOut))}`;
  const assetUrl = (relFromAssetRoot) => url(`${assetRoot}/${posix(relFromAssetRoot)}`);

  if (clean) rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // --- 1. dependencies ------------------------------------------------------
  const vendorEntries = collectEntryPoints({ from: modulesFrom, dependencies });
  const vendor = await bundleVendor({
    entries: vendorEntries,
    outdir: join(out, vendorDir),
    outRoot: out,
    absWorkingDir: root,
    minify: minifyVendor,
    target,
  });

  // --- 2. project modules ---------------------------------------------------
  const hashedOf = await emitModules({
    src, include, exclude, extensions, minify, target, outDir: assetDir,
  });

  // --- 3. the import map ----------------------------------------------------
  //
  // Each project module is keyed by *where its neighbours resolve it to*. The
  // browser turns a relative specifier into a URL before consulting the map, so
  // a key of "/assets/shared/stack.js" intercepts "../shared/stack.js" from a
  // sibling module exactly as a bare "@3sln/dodo" is intercepted.
  const imports = {};
  for (const [rel, hashed] of hashedOf) {
    if (!rel.endsWith('.js')) continue;
    imports[assetUrl(rel)] = assetUrl(hashed);
  }
  for (const [specifier, href] of vendor.urlFor) imports[specifier] = href;

  // --- 4. entry stylesheets -------------------------------------------------
  const styles = await bundleStyles({
    src, entries, outDir: assetDir, minify: minifyCss, absWorkingDir: root,
  });

  // --- 5. wire-up scripts ---------------------------------------------------
  const wireups = new Map();
  const result = { config, buildId: '', entries: {}, imports, modules: hashedOf, vendor, styles };

  for (const [name, entry] of Object.entries(entries)) {
    if (!hashedOf.has(posix(entry.module))) {
      fail(
        `Entry "${name}" names ${entry.module}, which was not fingerprinted. ` +
        `Is it under ${relative(root, src)}${include ? `/{${include.join(',')}}` : ''}, ` +
        `and does its extension appear in \`extensions\`?`,
      );
    }
    const moduleUrl = assetUrl(hashedOf.get(posix(entry.module)));
    const cssUrl = styles.has(name) ? assetUrl(styles.get(name)) : null;
    const source = wireupSource({
      name,
      imports,
      css: cssUrl ? [cssUrl] : [],
      module: moduleUrl,
    });
    const rel = `wireup-${name}.${shortHash(Buffer.from(source))}.js`;
    writeFileAt(join(assetDir, rel), source);
    wireups.set(name, assetUrl(rel));
    result.entries[name] = { module: moduleUrl, css: cssUrl, wireup: assetUrl(rel) };
  }

  // --- 6. the build id ------------------------------------------------------
  //
  // Derived from the emitted filenames, which already carry content hashes, so
  // an unchanged build produces an unchanged id: a redeploy that changes
  // nothing does not retire every client's service-worker cache.
  result.buildId = digestOf([
    ...hashedOf.values(),
    ...vendor.urlFor.values(),
    ...styles.values(),
    ...wireups.values(),
  ]);

  // --- 7. copied files ------------------------------------------------------
  const copied = [];
  for (const item of copy) {
    const { from, to } = typeof item === 'string' ? { from: item, to: item } : item;
    const source = join(root, from);
    if (!existsSync(source)) fail(`copy: ${from} does not exist.`);
    const dest = join(out, to === '.' ? '' : to);
    copyInto(source, dest);
    for (const f of walk(dest)) copied.push(posix(relative(out, f)));
  }
  result.copied = copied;

  // --- 8. HTML --------------------------------------------------------------
  //
  // The only rewrite: the wire-up tag. A page says
  // `<script src="/@wireup/app.js"></script>` in the repository -- which is
  // what the dev server answers -- and gets the hashed URL here.
  const rewritten = [];
  for (const { from, to } of html) {
    const source = join(root, from);
    if (!existsSync(source)) fail(`html: ${from} does not exist.`);
    let text = readFileSync(source, 'utf8');
    let hit = false;
    for (const [name, href] of wireups) {
      const dev = wireupHref(wireupPath, name);
      if (!text.includes(dev)) continue;
      text = text.split(dev).join(href);
      hit = true;
    }
    if (!hit) {
      fail(
        `${from} carries no wire-up tag. Expected a script whose src is one of ` +
        `${[...wireups.keys()].map((n) => wireupHref(wireupPath, n)).join(', ')}.`,
      );
    }
    writeFileAt(join(out, to), text);
    rewritten.push(posix(to));
  }
  result.html = rewritten;

  // --- 9. the manifest ------------------------------------------------------
  if (manifest) {
    writeFileAt(manifest, `// Generated by @3sln/js-tools -- do not edit.
export const BUILD_ID = ${JSON.stringify(result.buildId)};
export const IMPORT_MAP = ${JSON.stringify({ imports })};
export const ENTRIES = ${JSON.stringify(result.entries, null, 2)};
`);
    result.manifest = manifest;
  }

  if (!quiet) {
    const names = Object.keys(entries);
    console.log(
      `build ${result.buildId}\n` +
      `  vendor:  ${vendor.urlFor.size} entry points, ${vendor.chunks} shared chunk(s), ` +
      `${(vendor.bytes / 1024).toFixed(0)} kB\n` +
      `  app:     ${hashedOf.size} modules content-addressed, ${styles.size} stylesheet(s), ` +
      `${names.length} wire-up${names.length === 1 ? '' : 's'} (${names.join(', ')})\n` +
      `  -> ${relative(root, out) || out}/`,
    );
  }

  return result;
}

export { normalise, defineConfig, loadConfig } from './config.js';
export { headersFile, securityHeadersFrom } from './headers.js';
export { wireupHref, wireupSource, DEFAULT_WIREUP_PATH } from './wireup.js';
export { collectEntryPoints, entryPointsFor, resolvePackageDir } from './entry-points.js';
export { BuildError } from './util.js';
