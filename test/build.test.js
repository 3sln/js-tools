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

describe('build — workers', () => {
  // Written per test rather than into the shared fixture: a worker in the base
  // fixture changes what every other test sees shipped.
  const WORKER = {
    'src/app/work.worker.js': [
      "import { esm } from 'esm-dep';",
      "import { helper } from '../shared/util.js';",
      'self.onmessage = () => self.postMessage(esm + helper());',
      '',
    ].join('\n'),
  };
  const withWorker = (root) => baseConfig(root, { workers: { work: 'app/work.worker.js' } });

  it('bundles a worker whole, so it needs no import map', async () => {
    // A worker has no import map: `../shared/util.js` would resolve to a key the
    // map rewrites rather than a file, and `esm-dep` would not resolve at all.
    // Both must be inside the emitted file.
    const { root } = setup(WORKER);
    const result = await build(withWorker(root));
    const url = result.workers.work;
    expect(url).toBeTruthy();
    const code = readFileSync(join(root, 'dist', url.replace(/^\//, '')), 'utf8');
    expect(code).toContain('helper');
    expect(code).toContain('esm-dep');
    expect(code).not.toContain("from '../shared/util.js'");
    expect(code).not.toContain("from 'esm-dep'");
  });

  it('names the bundle after its contents and maps the source path to it', async () => {
    const { root } = setup(WORKER);
    const result = await build(withWorker(root));
    expect(result.workers.work).toMatch(/work\.worker\.[0-9a-f]{6,}\.js$/);
    // Keyed by where the caller would name it, so import.meta.resolve finds it.
    expect(result.imports['/assets/app/work.worker.js']).toBe(result.workers.work);
  });

  it('does not also ship the worker as a loose module', async () => {
    // That copy could only ever fail, and would sit next to a working one.
    const { root } = setup(WORKER);
    const result = await build(withWorker(root));
    expect([...result.modules.keys()]).not.toContain('app/work.worker.js');
  });

  it('takes a worker a dependency ships, by the name node resolves', async () => {
    // pdf.js and friends ship their own. Reaching into node_modules with a
    // relative path would be a lie about where it comes from, and would break
    // the moment the package moved it.
    const { root } = setup({
      'node_modules/worker-dep/package.json': JSON.stringify({
        name: 'worker-dep', version: '1.0.0', type: 'module', main: 'index.js',
      }),
      'node_modules/worker-dep/index.js': 'export const x = 1;\n',
      'node_modules/worker-dep/dist/thing.worker.js':
        "import { x } from '../index.js';\nself.onmessage = () => self.postMessage(x);\n",
    });
    const result = await build(
      baseConfig(root, { workers: { thing: 'worker-dep/dist/thing.worker.js' } }),
    );
    expect(result.workers.thing).toMatch(/workers\/thing\.[0-9a-f]{6,}\.js$/);
    // Keyed by the specifier that was written, like a dependency's entry point.
    expect(result.imports['worker-dep/dist/thing.worker.js']).toBe(result.workers.thing);
  });

  it('prefers a file under src when both could match', async () => {
    const { root } = setup({
      ...WORKER,
      'node_modules/app/package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
    });
    const result = await build(withWorker(root));
    expect(result.imports['/assets/app/work.worker.js']).toBe(result.workers.work);
  });

  it('refuses a worker that is neither', async () => {
    const { root } = setup();
    await expect(
      build(baseConfig(root, { workers: { nope: 'not/anywhere.js' } })),
    ).rejects.toThrow(/neither a file under src nor a resolvable module/);
  });

  it('says nothing about workers when none are declared', async () => {
    const { root } = setup();
    const result = await build(baseConfig(root));
    expect(result.workers).toEqual({});
  });
});

describe('build — dependencies', () => {
  it('gives every exported subpath its own entry point', async () => {
    const { root } = setup();
    const result = await build(baseConfig(root));
    expect([...result.vendor.urlFor.keys()].sort()).toEqual([
      'browser-dep', 'cjs-dep', 'conditions-dep', 'esm-dep', 'multi-dep', 'multi-dep/extra',
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

  it('applies a `browser` map of redirects rather than treating it as a path', async () => {
    // jszip's shape. Handing the map itself over as a filename resolved to
    // nothing, and the package disappeared from the import map without a word.
    const { root } = setup();
    const result = await build(baseConfig(root));
    const href = result.vendor.urlFor.get('browser-dep');
    const body = read(root, `dist${decodeURIComponent(href)}`);
    expect(body).toContain('browser-dep');
    expect(body).not.toContain('node');
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

describe('build — copied files', () => {
  it('takes a single file as readily as a directory', async () => {
    const { root } = setup({ 'static/robots.txt': 'User-agent: *\n', 'static/img/a.txt': 'a' });
    const result = await build(baseConfig(root, {
      copy: [
        { from: 'static/robots.txt', to: 'robots.txt' },
        { from: 'static/img', to: 'img' },
      ],
    }));
    expect(result.copied.sort()).toEqual(['img/a.txt', 'robots.txt']);
    expect(read(root, 'dist/robots.txt')).toContain('User-agent');
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

describe('build — the graph check', () => {
  it('fails on a specifier the map does not cover, and names the importer', async () => {
    const { root } = setup({
      'src/shared/util.js': 'import "ghost";\nexport const helper = () => "helper";\n',
    });
    await expect(build(baseConfig(root))).rejects.toThrow(/ghost.*shared\/util\.js/s);
  });

  it('follows a dynamic import, which is where the silent failure was', async () => {
    const { root } = setup({
      'src/app/main.js': 'export const boot = () => import("phantom");\n',
    });
    await expect(build(baseConfig(root))).rejects.toThrow(/phantom/);
  });

  it('walks more than one entry point', async () => {
    // esbuild wants an outdir the moment there are two inputs, even with
    // nothing being written.
    const { root } = setup({ 'src/app/second.js': 'import "ghost";\nexport const x = 1;\n' });
    const config = baseConfig(root, {
      entries: {
        app: { module: 'app/main.js', css: 'app/app.css' },
        second: { module: 'app/second.js' },
      },
    });
    await expect(build(config)).rejects.toThrow(/ghost/);
  });

  it('lets node: through, and anything listed in allowUnresolved', async () => {
    const { root } = setup({
      'src/shared/util.js': 'import "node:crypto";\nimport "provided";\nexport const helper = () => 1;\n',
    });
    const result = await build(baseConfig(root, { allowUnresolved: ['provided'] }));
    expect(result.buildId).toBeTruthy();
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
