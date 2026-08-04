// The development half of the same build.
//
// A dev server that disagrees with the builder about which files are project
// modules, which packages are dependencies, or where an entry point lives is
// the whole class of bug that only shows up after a deploy. So both read one
// config, and both answer the same URL for the wire-up script -- which is why
// a page can carry `<script src="/@wireup/app.js"></script>` and be
// byte-identical in the repository and in production.
//
// What differs is only what the wire-up says:
//
//   built        map -> hashed vendor bundles and fingerprinted modules
//   development  map -> node_modules and the source tree, unhashed
//
// Project modules are served as they are, which is what makes hot module
// replacement possible at all: the file the browser is running is the file on
// disk, so there is something to replace.
import { hmrPlugin } from '@web/dev-server-hmr';
import { join, relative } from 'node:path';
import { normalise } from '../config.js';
import { wireupHref, wireupSource } from '../wireup.js';
import { encodePath, posix } from '../util.js';
import { VENDOR_PREFIX, vendorGraph } from './vendor.js';

// Where the converted-dependency cache is served from. It lives under
// node_modules, so it is already inside the served root and the static file
// middleware can do the work -- this is a prefix rewrite, not a handler, so the
// relative chunk imports inside a split bundle resolve too.
const CACHE_URL = '/node_modules/.cache/3sln-js-tools/vendor/';

export function devServerConfig(rawConfig, overrides = {}) {
  const config = normalise(rawConfig);
  const { root, src, entries, wireupPath } = config;
  const vendor = vendorGraph(config);

  // The dev URL of a file in the source tree: the file itself, unhashed.
  const srcUrl = (rel) => `/${encodePath(posix(relative(root, join(src, rel))))}`;

  const wireupFor = new Map(
    Object.keys(entries).map((name) => [wireupHref(wireupPath, name), name]),
  );

  const middleware = async (context, next) => {
    if (context.path.startsWith(VENDOR_PREFIX)) {
      await vendor.ensure();
      context.url = CACHE_URL + context.path.slice(VENDOR_PREFIX.length) + (context.search || '');
      return next();
    }

    const name = wireupFor.get(context.path);
    if (name) {
      const { imports } = await vendor.ensure();
      const entry = entries[name];
      context.type = 'application/javascript';
      // No caching: the map changes whenever a dependency does, and this is
      // the one file that cannot be allowed to go stale.
      context.set('cache-control', 'no-store');
      context.body = wireupSource({
        name,
        imports,
        css: entry.css ? [srcUrl(entry.css)] : [],
        module: srcUrl(entry.module),
      });
      return undefined;
    }

    return next();
  };

  const { middleware: extraMiddleware = [], plugins: extraPlugins = [], hmr = {}, ...rest } = overrides;

  return {
    rootDir: root,
    // Bare specifiers are resolved by the import map the wire-up script
    // installs, exactly as they are in production. Letting the dev server
    // rewrite them instead would make development the only place the map is
    // not what resolves the graph.
    nodeResolve: false,
    middleware: [middleware, ...extraMiddleware],
    plugins: [
      hmrPlugin({ exclude: ['**/node_modules/**'], ...hmr }),
      ...extraPlugins,
    ],
    ...rest,
  };
}

// The name a config file is most likely to want.
export { devServerConfig as devServer };
export { vendorGraph };
