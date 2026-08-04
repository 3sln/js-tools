import { afterEach, describe, expect, it } from 'bun:test';
import { startDevServer } from '@web/dev-server';
import { devServerConfig } from '../src/dev/server.js';
import { baseConfig, makeFixture } from './fixture.js';

let fixture = null;
let server = null;

afterEach(async () => {
  await server?.stop();
  server = null;
  fixture?.cleanup();
  fixture = null;
});

// A real server on a real port. The dev half is mostly about what a browser
// receives, and the only honest way to check that is to ask for it.
async function serve(files, over) {
  fixture = makeFixture(files);
  const config = devServerConfig(baseConfig(fixture.root, over), { port: 0 });
  server = await startDevServer({
    config,
    readCliArgs: false,
    readFileConfig: false,
    logStartMessage: false,
    autoExitProcess: false,
  });
  const { port } = server.server.address();
  const get = (path) => fetch(`http://127.0.0.1:${port}${path}`);
  // The wire-up embeds the map as a JS object literal it stringifies at
  // runtime, so this is how a test gets at it without a browser.
  const importMap = async () => {
    const src = await (await get('/@wireup/app.js')).text();
    return JSON.parse(src.match(/JSON\.stringify\((\{[\s\S]*?\})\);/)[1]);
  };
  return { root: fixture.root, get, importMap };
}

describe('dev server', () => {
  it('answers the same wire-up URL the built page carries', async () => {
    const { get } = await serve();
    const res = await get('/@wireup/app.js');
    expect(res.status).toBe(200);

    const src = await res.text();
    expect(src).toContain('importmap');
    // Unhashed, and pointing at the source tree -- which is what makes hot
    // replacement possible: the file the browser runs is the file on disk.
    expect(src).toContain('/src/app/main.js');
    expect(src).toContain('/src/app/app.css');
  });

  it('serves an ES module dependency straight out of node_modules', async () => {
    const { get, importMap } = await serve();
    const map = await importMap();

    expect(map.imports['esm-dep']).toBe('/node_modules/esm-dep/index.js');
    const res = await get(map.imports['esm-dep']);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('esm-dep');
  });

  it('converts a CommonJS dependency with esbuild and serves the result', async () => {
    const { get, importMap } = await serve();
    const map = await importMap();

    expect(map.imports['cjs-dep']).toStartWith('/@vendor/');
    const res = await get(map.imports['cjs-dep']);
    expect(res.status).toBe(200);
    // Wrapped, not rewritten: the CommonJS body survives inside an esbuild
    // shim and the file the browser gets is an ES module with a default export.
    const body = await res.text();
    expect(body).toContain('export default');
    expect(body).toContain('sourceMappingURL');
  });

  it('maps a wildcard subpath to a directory prefix', async () => {
    const { get, importMap } = await serve();
    const map = await importMap();

    expect(map.imports['multi-dep/src/']).toBe('/node_modules/multi-dep/src/');
    expect((await get('/node_modules/multi-dep/src/deep.js')).status).toBe(200);
  });

  it('serves project modules as they are, with their imports intact', async () => {
    const { get } = await serve();
    const res = await get('/src/app/main.js');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"esm-dep"');
    expect(body).toContain('"../shared/util.js"');
  });
});
