# @3sln/js-tools

A builder and a development server for applications that ship **unbundled ES
modules**, with nothing cache-busted and nothing rewritten.

```sh
npm install --save-dev @3sln/js-tools
```

Two kinds of code have two different shapes, so they get two treatments:

|  | Project modules | Dependencies |
| --- | --- | --- |
| Shipped as | one file per module, as authored (or minified) | bundled, split by entry point |
| Named | `main.<hash>.js` | `dodo-<HASH>.js` |
| Changed by | an edit to that one file | a version bump |

Project modules change one at a time, and a bundle means every edit invalidates
every file. Dependencies change rarely and must not be duplicated — bundling
`@3sln/dodo` and `@3sln/dodo/reactive` as two separate bundles would give each
its own copy of dodo's internals, so a cell created through one would not be
recognised by the other. Splitting is what keeps a package a singleton; it is
not a size optimisation.

Everything a browser keeps long-term is content-addressed, so **a changed file
is a changed URL**. Nothing is ever overwritten, so nothing needs invalidating —
and a browser holding a poisoned copy of an old URL simply never asks for it
again.

## No source is rewritten

Import statements stay exactly as authored. An **import map** does the
redirection:

```json
{
  "imports": {
    "@3sln/dodo":              "/assets/vendor/3sln_dodo-QK3PZ7.js",
    "/assets/shared/stack.js": "/assets/shared/stack.4f2c1ab9de.js"
  }
}
```

A browser resolves a relative specifier to a URL *before* it consults the map,
so the second key intercepts `../shared/stack.js` from a sibling module exactly
as the first intercepts a bare specifier. That is why the source tree is
*mirrored* under the asset root rather than hashed in place: one prefix covers
every neighbour import in the graph, and one `_headers` rule can mark the whole
tree immutable.

## The wire-up script

A page needs three things before it can run: the import map, the entry
stylesheet and the entry module. All three are content-addressed, so all three
change on most builds — which is a lot of coupling to hand to a hand-written
`index.html`, or to a worker rendering HTML per request.

So the build emits one **synchronous classic script** that does all three, and
the page carries a single tag:

```html
<script src="/@wireup/app.js"></script>
```

The build rewrites that to the hashed URL. The dev server answers the same URL
with development paths in it. The page is byte-identical either way, and
nothing downstream of it needs to know what a hash is.

> It must come **before any module script** in the document: an import map has
> to be installed before the first module load is triggered. Since the wire-up
> appends the entry module itself, everything after it is in order by
> construction.

Two details it takes care of that are easy to get wrong by hand:

- A module script *inserted into the DOM* is not deferred — unlike one written
  in the markup, it runs the moment it has loaded, which can be before the body
  exists. The wire-up starts the fetch immediately with `modulepreload` (which
  follows the import map, so it warms the whole unbundled graph rather than just
  the entry) and appends the script at `DOMContentLoaded`.
- An import map is inline script content as far as CSP is concerned, even
  created through the DOM. The wire-up copies its own `nonce` onto the map, so a
  page under a nonce policy works with no extra configuration — and it is a
  no-op for a policy that does not use nonces.

## Getting started

```js
// jstools.config.js
import { defineConfig } from '@3sln/js-tools';

export default defineConfig({
  src: 'src',
  include: ['client', 'shared'],   // src/worker is server-side; never shipped
  out: 'dist/client',
  assetRoot: 'assets',
  entries: {
    app: { module: 'client/main.js', css: 'client/app.css' },
  },
  html: ['index.html'],
  manifest: 'dist/client-manifest.js',
});
```

```json
{
  "scripts": {
    "build": "3sln-build",
    "dev": "3sln-dev --open"
  }
}
```

A project that needs to emit more than the client — a static site, a service
worker with the build id stamped into it, a `_headers` file listing its own
stable names — calls the builder from a script instead:

```js
import { build, headersFile } from '@3sln/js-tools';
import config from './jstools.config.js';

const result = await build(config);
// result.buildId, .entries, .imports, .modules, .copied, .html
```

### Development

```js
// web-dev-server.config.js
import { devServer } from '@3sln/js-tools/dev-server';
import config from './jstools.config.js';

export default devServer(config, {
  appIndex: 'index.html',
  middleware: [/* anything the project mounts itself */],
});
```

One config drives both halves. A dev server that disagrees with the builder
about which files are project modules or where an entry point lives is the whole
class of bug that only shows up after a deploy.

What the dev server does differently:

- **Project modules are served as they are**, which is what makes hot module
  replacement possible at all — the file the browser is running is the file on
  disk, so there is something to replace. HMR is `@web/dev-server-hmr`; a module
  that does not opt in through `import.meta.hot` falls back to a page reload.
- **ES module dependencies are served straight out of `node_modules`**, so a
  stack trace names the real file and a linked package is edited and reloaded
  like any other source.
- **Everything else is converted by esbuild and cached** under
  `node_modules/.cache/3sln-js-tools/`, served from `/@vendor/`. They are
  converted *together*, with splitting, and every directly-served ESM specifier
  is marked external — so a converted package reaches its ESM dependencies
  through the import map rather than inlining a second copy of them. The cache
  is rebuilt when one of those files changes on disk.
- **Bare specifiers still resolve through the import map**, not through
  `nodeResolve`. Development is not the one place where something other than the
  map resolves the graph.

## Config

| Key | Default | |
| --- | --- | --- |
| `root` | `process.cwd()` | everything else is relative to it |
| `src` | `'src'` | the project module root |
| `include` | all of `src` | subdirectories to ship; a `worker/` or `server/` tree belongs outside it |
| `exclude` | `[]` | paths within `include` to skip (`sw.js`) |
| `extensions` | `['.js']` | what gets fingerprinted |
| `entries` | — | `{name: {module, css}}`, relative to `src` |
| `out` | `'dist'` | |
| `assetRoot` | `'assets'` | the immutable, content-addressed prefix |
| `vendorDir` | `'<assetRoot>/vendor'` | |
| `packageJson` | `'package.json'` | where dependencies are read and resolved from |
| `dependencies` | its `dependencies` | override to ship a subset |
| `minify` | `false` | project modules; imports survive either way |
| `minifyVendor` / `minifyCss` | `true` | |
| `wireupPath` | `'/@wireup/[name].js'` | the URL a page carries, and the dev server answers |
| `copy` | `[]` | `{from, to}` copied verbatim |
| `html` | `[]` | pages whose wire-up tag is rewritten |
| `manifest` | `'dist/client-manifest.js'` | `null` to skip |
| `check` | `true` | walk the shipped graph and fail on an unmapped specifier |
| `allowUnresolved` | `[]` | specifiers provided some other way |

## The graph is checked before the build reports success

Every bare specifier reachable from an entry has to be in the import map.
esbuild does the walking, so dynamic imports and re-exports are covered without
a regex guessing at JavaScript, and a miss names the file that imported it:

```
build failed: 1 specifier(s) in the shipped graph are not in the import map:
  jszip — imported by src/client/console/bl/lpfImport.js
```

This exists because the failure it catches is silent. jszip states its browser
entry as a *map of redirects* rather than a filename; a resolver that hands the
map over as a path resolves nothing, and the package disappears from the import
map with the build still green. What you get is a blank page at runtime, in
whichever code path lazily imported it.

## The manifest

A JS module the server side can import, so an application that renders its own
HTML never hard-codes a hashed URL:

```js
export const BUILD_ID = 'a91c4f0e22';
export const IMPORT_MAP = { imports: { /* … */ } };
export const ENTRIES = {
  app: {
    module: '/assets/client/main.4f2c1ab9de.js',
    css:    '/assets/app.9b1e77c204.css',
    wireup: '/assets/wireup-app.31c0af8e12.js',
  },
};
```

`BUILD_ID` is derived from the emitted filenames, which already carry content
hashes — so a build that changes nothing produces the same id, and a redeploy
does not retire every client's service-worker cache.

## `_headers`

```js
import { headersFile, securityHeadersFrom } from '@3sln/js-tools';

writeFileSync('dist/_headers', headersFile({
  assetRoot: 'assets',
  security: securityHeadersFrom(readFileSync('site/_headers', 'utf8')),
  revalidate: ['index.html', 'sw.js', 'manifest.json'],
}));
```

`immutable` is claimed only where it is true. Claiming it on a stable-named
entry point is what turns a deploy into a blank page: the browser will not
re-check it, so it goes on importing modules from a build that no longer
exists — and because that is a link-time failure, the whole graph dies before a
line runs.

The other trap is that Cloudflare **appends** matching rules rather than
replacing them, and the strictest value wins. A `Cache-Control` on a catch-all
arrives alongside the one on the asset root as
`no-cache, public, max-age=…, immutable`, and `no-cache` wins — silently
throwing away the caching the content addressing exists to enable. So exactly
one rule may set `Cache-Control` for any given path: the catch-all carries
security headers only, and everything with a stable name is listed.

## Deep imports are unsupported

A wildcard subpath (`"./src/*"`) cannot become a build entry point without
enumerating what it might match, and giving a package's internals their own
entry points would hand out a second copy of the package — the one thing this
arrangement exists to prevent. The dev server, where nothing is bundled and a
second copy is not a risk, maps a wildcard to a directory prefix.

## Releasing

Bumping `version` in `package.json` on `main` opens a draft release. Publishing
that draft creates the tag and publishes to npm, after re-running the tests and
checking the tag matches `package.json` — a version bump alone tags nothing.
