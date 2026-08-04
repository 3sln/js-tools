import { afterEach, describe, expect, it } from 'bun:test';
import { collectEntryPoints, entryPointsFor, isEsm, readPackage } from '../src/entry-points.js';
import { headersFile, securityHeadersFrom } from '../src/headers.js';
import { wireupSource } from '../src/wireup.js';
import { makeFixture } from './fixture.js';

let fixture = null;
const setup = (files) => (fixture = makeFixture(files));
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

describe('entry points', () => {
  it('reads one per exported subpath, ignoring ./package.json', () => {
    const { root } = setup();
    const found = entryPointsFor('multi-dep', { from: root }).map((e) => e.specifier);
    expect(found).toEqual(['multi-dep', 'multi-dep/extra']);
  });

  it('returns a wildcard as a directory prefix only when asked', () => {
    const { root } = setup();
    const withCards = entryPointsFor('multi-dep', { from: root, wildcards: true });
    const card = withCards.find((e) => e.wildcard);
    expect(card.specifier).toBe('multi-dep/src/');
    expect(card.dir).toEndWith('multi-dep/src');
  });

  it('falls back to main when there is no exports field', () => {
    const { root } = setup();
    expect(entryPointsFor('esm-dep', { from: root })[0].file).toEndWith('esm-dep/index.js');
  });

  it('resolves a main with no extension', () => {
    const { root } = setup();
    expect(entryPointsFor('cjs-dep', { from: root })[0].file).toEndWith('cjs-dep/lib/index.js');
  });

  it('finds a dependency of a dependency, hoisted or not', () => {
    const { root } = setup({
      'node_modules/esm-dep/package.json': JSON.stringify({
        name: 'esm-dep', version: '1.0.0', type: 'module', main: 'index.js',
        dependencies: { nested: '*' },
      }),
      'node_modules/esm-dep/node_modules/nested/package.json': JSON.stringify({
        name: 'nested', version: '1.0.0', type: 'module', main: 'index.js',
      }),
      'node_modules/esm-dep/node_modules/nested/index.js': 'export const n = 1;\n',
    });
    const flat = collectEntryPoints({ from: root, dependencies: ['esm-dep'] });
    expect(flat.map((e) => e.specifier)).toEqual(['esm-dep']);

    const deep = collectEntryPoints({ from: root, dependencies: ['esm-dep'], recursive: true });
    expect(deep.map((e) => e.specifier)).toEqual(['esm-dep', 'nested']);
  });

  it('says nothing is installed rather than building an empty page', () => {
    const { root } = setup();
    expect(() => collectEntryPoints({ from: root, dependencies: ['absent'] })).toThrow(/installed/);
  });
});

describe('isEsm', () => {
  it('trusts type: module and the .mjs extension', () => {
    const { root } = setup();
    const esm = entryPointsFor('esm-dep', { from: root })[0];
    expect(isEsm(readPackage(esm.pkgDir), esm.file)).toBe(true);
  });

  it('refuses a CommonJS file', () => {
    const { root } = setup();
    const cjs = entryPointsFor('cjs-dep', { from: root })[0];
    expect(isEsm(readPackage(cjs.pkgDir), cjs.file)).toBe(false);
  });

  it('recognises an ESM build in a package with no type field', () => {
    const { root } = setup({
      'node_modules/esm-dep/package.json': JSON.stringify({
        name: 'esm-dep', version: '1.0.0', module: 'build/index.js',
      }),
      'node_modules/esm-dep/build/index.js': 'export const x = 1;\nexport default x;\n',
    });
    const found = entryPointsFor('esm-dep', { from: root })[0];
    expect(isEsm(readPackage(found.pkgDir), found.file)).toBe(true);
  });

  it('says no when a file looks like both, because bundling is the safe answer', () => {
    const { root } = setup({
      'node_modules/esm-dep/package.json': JSON.stringify({
        name: 'esm-dep', version: '1.0.0', main: 'index.js',
      }),
      'node_modules/esm-dep/index.js': 'export const x = require("./y.js");\n',
    });
    const found = entryPointsFor('esm-dep', { from: root })[0];
    expect(isEsm(readPackage(found.pkgDir), found.file)).toBe(false);
  });
});

describe('the wire-up script', () => {
  it('is a classic script that installs the map before the entry', () => {
    const src = wireupSource({
      name: 'app',
      imports: { 'a-dep': '/assets/vendor/a.js' },
      css: ['/assets/app.css'],
      module: '/assets/main.js',
    });
    // The map must be appended before the module script, or the module resolves
    // its bare specifiers against nothing.
    expect(src.indexOf('importmap')).toBeLessThan(src.indexOf('/assets/main.js'));
    expect(src).toContain('"a-dep"');
    expect(src).toContain('stylesheet');
    expect(src.startsWith('//')).toBe(true);
  });

  it('does not install itself twice in one document', () => {
    const src = wireupSource({ name: 'app', imports: {}, module: '/m.js' });
    expect(src).toContain('data-wireup');
    expect(src).toContain('return;');
  });
});

describe('_headers', () => {
  it('claims immutable only on the asset root', () => {
    const text = headersFile({ assetRoot: 'assets', revalidate: ['index.html', 'sw.js'] });
    const immutable = text.split('\n').filter((l) => /^\s+Cache-Control:.*immutable/.test(l));
    expect(immutable).toHaveLength(1);
    expect(text).toContain('/assets/*');
    expect(text).toContain('/index.html\n  Cache-Control: no-cache');
    expect(text).toContain('/sw.js\n  Cache-Control: no-cache');
  });

  it('keeps hand-written security headers and drops any Cache-Control', () => {
    const security = securityHeadersFrom([
      '/*',
      '  X-Frame-Options: DENY',
      '  Cache-Control: immutable',
      '  Referrer-Policy: no-referrer',
    ].join('\n'));
    expect(security).toBe('  X-Frame-Options: DENY\n  Referrer-Policy: no-referrer');

    const text = headersFile({ assetRoot: 'assets', security });
    expect(text).toContain('X-Frame-Options');
    expect(text.split('\n').filter((l) => /cache-control/i.test(l))).toHaveLength(1);
  });
});
