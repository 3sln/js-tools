import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from '../src/build.js';
import { BuildError } from '../src/util.js';
import { baseConfig, makeFixture } from './fixture.js';

let fixture = null;
const setup = (files) => (fixture = makeFixture(files));
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

const read = (root, rel) => readFileSync(join(root, rel), 'utf8');

describe('build — project modules', () => {
  it('fingerprints each module individually and never bundles them', async () => {
    const { root } = setup();
    const result = await build(baseConfig(root));

    const main = result.modules.get('app/main.js');
    expect(main).toMatch(/^app\/main\.[0-9a-f]{10}\.js$/);

    // The import statements are exactly as authored -- that is what the import
    // map depends on.
    const emitted = read(root, join('dist/assets', main));
    expect(emitted).toContain('from "esm-dep"');
    expect(emitted).toContain('from "../shared/util.js"');
  });

  it('ships only what `include` names', async () => {
    const { root } = setup();
    const result = await build(baseConfig(root));
    expect([...result.modules.keys()]).toEqual(['app/main.js', 'shared/util.js']);
    expect(existsSync(join(root, 'dist/assets/server'))).toBe(false);
  });

  it('honours `exclude` within an included directory', async () => {
    const { root } = setup();
    const result = await build(baseConfig(root, { exclude: ['shared/util.js'] }));
    expect([...result.modules.keys()]).toEqual(['app/main.js']);
  });

  it('minifies without bundling, so the imports survive', async () => {
    const { root } = setup();
    const result = await build(baseConfig(root, { minify: true }));
    const emitted = read(root, join('dist/assets', result.modules.get('app/main.js')));
    expect(emitted).toContain('esm-dep');
    expect(emitted).toContain('../shared/util.js');
    expect(emitted).not.toContain('export const boot = () =>');
  });
});

describe('build — dependencies', () => {
  it('gives every exported subpath its own entry point', async () => {
    const { root } = setup();
    const result = await build(baseConfig(root));
    expect([...result.vendor.urlFor.keys()].sort()).toEqual([
      'cjs-dep', 'esm-dep', 'multi-dep', 'multi-dep/extra',
    ]);
  });

  it('splits what two subpaths share into a chunk rather than copying it', async () => {
    const { root } = setup();
    const result = await build(baseConfig(root));
    expect(result.vendor.chunks).toBeGreaterThan(0);

    // The shared module must exist once. If splitting were off, both entries
    // would carry their own copy and multi-dep would not be a singleton.
    const files = readdirSync(join(root, 'dist/assets/vendor'));
    const carriers = files.filter((f) => read(root, join('dist/assets/vendor', f)).includes('multi'));
    expect(carriers).toHaveLength(1);
  });

  it('resolves an extensionless main and converts CommonJS', async () => {
    const { root } = setup();
    const result = await build(baseConfig(root));
    const href = result.vendor.urlFor.get('cjs-dep');
    expect(read(root, `dist${decodeURIComponent(href)}`)).toContain('cjs-dep');
  });

  it('leaves wildcard subpaths out of the built map', async () => {
    const { root } = setup();
    const result = await build(baseConfig(root));
    expect(result.imports['multi-dep/src/']).toBeUndefined();
  });
});

describe('build — the import map', () => {
  it('keys a module by where its neighbours resolve it to', async () => {
    const { root } = setup();
    const result = await build(baseConfig(root));

    // "../shared/util.js" from src/app/main.js resolves against the *asset*
    // URL of main.js, so this is the key that has to intercept it.
    const key = '/assets/shared/util.js';
    expect(result.imports[key]).toMatch(/^\/assets\/shared\/util\.[0-9a-f]{10}\.js$/);
    expect(result.imports['/assets/app/main.js']).toBe(result.entries.app.module);
  });

  it('maps every bare specifier', async () => {
    const { root } = setup();
    const result = await build(baseConfig(root));
    for (const dep of ['esm-dep', 'cjs-dep', 'multi-dep', 'multi-dep/extra']) {
      expect(result.imports[dep]).toStartWith('/assets/vendor/');
    }
  });
});

describe('build — the wire-up script', () => {
  it('carries the map, the stylesheet and the entry module', async () => {
    const { root } = setup();
    const result = await build(baseConfig(root));
    const src = read(root, `dist${result.entries.app.wireup}`);

    expect(src).toContain('importmap');
    expect(src).toContain('"esm-dep"');
    expect(src).toContain(result.entries.app.module);
    expect(src).toContain(result.entries.app.css);
    // A classic script, so it runs synchronously before any module does.
    expect(src).not.toContain('import ');
  });

  it('bundles the entry stylesheet, inlining its @import', async () => {
    const { root } = setup();
    const result = await build(baseConfig(root));
    const css = read(root, `dist${result.entries.app.css}`);
    expect(css).toContain('--x');
    expect(css).toContain('red');
    expect(css).not.toContain('@import');
  });

  it('rewrites the wire-up tag in an HTML page', async () => {
    const { root } = setup();
    const result = await build(baseConfig(root, { html: ['index.html'] }));
    const html = read(root, 'dist/index.html');
    expect(html).toContain(`src="${result.entries.app.wireup}"`);
    expect(html).not.toContain('/@wireup/app.js');
  });

  it('refuses an HTML page with no wire-up tag', async () => {
    const { root } = setup({ 'index.html': '<!doctype html><html></html>' });
    await expect(build(baseConfig(root, { html: ['index.html'] }))).rejects.toThrow(BuildError);
  });
});

describe('build — the build id', () => {
  it('is unchanged by a build that emits the same bytes', async () => {
    const { root } = setup();
    const a = await build(baseConfig(root));
    const b = await build(baseConfig(root));
    expect(b.buildId).toBe(a.buildId);
  });

  it('changes when a single module changes, and only that module rehashes', async () => {
    const { root, write } = setup();
    const a = await build(baseConfig(root));
    write('src/shared/util.js', 'export const helper = () => "changed";\n');
    const b = await build(baseConfig(root));

    expect(b.buildId).not.toBe(a.buildId);
    expect(b.modules.get('shared/util.js')).not.toBe(a.modules.get('shared/util.js'));
    expect(b.modules.get('app/main.js')).toBe(a.modules.get('app/main.js'));
  });
});

describe('build — the manifest', () => {
  it('is importable and names every entry', async () => {
    const { root } = setup();
    const result = await build(baseConfig(root));
    const mod = await import(join(root, 'dist/manifest.js'));
    expect(mod.BUILD_ID).toBe(result.buildId);
    expect(mod.ENTRIES.app.module).toBe(result.entries.app.module);
    expect(mod.ENTRIES.app.wireup).toBe(result.entries.app.wireup);
    expect(mod.IMPORT_MAP.imports['esm-dep']).toBe(result.imports['esm-dep']);
  });
});

describe('build — failures', () => {
  it('names the entry it could not find', async () => {
    const { root } = setup();
    const config = baseConfig(root, { entries: { app: { module: 'app/nope.js' } } });
    await expect(build(config)).rejects.toThrow(/app\/nope\.js/);
  });

  it('says so when nothing is installed', async () => {
    const { root } = setup({
      'node_modules/esm-dep/package.json': null,
      'package.json': JSON.stringify({ name: 'fixture', type: 'module', dependencies: { absent: '*' } }),
    });
    await expect(build(baseConfig(root))).rejects.toThrow(/installed/);
  });
});
