# @3sln/js-tools — agent notes

`README.md` is the interface. This file is about the invariants, most of which
were paid for by an outage.

## The invariants

- **Never claim `immutable` on a stable name.** That single rule is the reason
  this package exists. A stable-named entry point marked immutable is one the
  browser will not re-check, so after a deploy it goes on importing modules from
  a build that no longer exists — and because a failed import is a *link-time*
  failure, the whole graph dies before a line runs: a blank page with only the
  background painted. `src/headers.js` claims it in exactly one place.
- **Exactly one rule may set `Cache-Control` for a path.** Cloudflare appends
  matching rules rather than replacing them and the strictest wins, so a
  catch-all `Cache-Control` silently defeats the one on the asset root. The
  catch-all carries security headers only.
- **Nothing is cache-busted.** No `?v=`, ever. A query string is a cache key the
  server cannot reason about and the service worker gets wrong. The filename
  carries the hash.
- **No source is rewritten.** Not imports, not paths. If something cannot be
  resolved by the import map, the answer is a better map key, not a rewrite.
  The one exception is the wire-up `<script src>` in an HTML page, which is a
  URL and not code.
- **The builder and the dev server read one config.** Two code paths that
  disagree about which files ship is a bug you find after deploying. Anything
  added to one half that changes what a specifier resolves to has to be added
  to the other.
- **Splitting is about identity, not size.** Turning it off would give each
  subpath of a package its own copy of the package's internals. Say this in
  the review of any change that touches `src/vendor.js`.

## The layout

| File | |
| --- | --- |
| `src/config.js` | the one config, its defaults, and `loadConfig` |
| `src/entry-points.js` | a package's `exports` → entry points; shared by both halves |
| `src/vendor.js` | the split esbuild bundle; used by the build *and* the dev cache |
| `src/modules.js` | fingerprinting project modules |
| `src/styles.js` | entry stylesheets, bundled so `@import` is inlined |
| `src/wireup.js` | the script that installs the map, the stylesheet and the entry |
| `src/verify.js` | walks the shipped graph; fails on a specifier the map misses |
| `src/headers.js` | `_headers` |
| `src/build.js` | the orchestration, and the package's public surface |
| `src/dev/vendor.js` | ESM straight from node_modules; everything else converted and cached |
| `src/dev/server.js` | the `@web/dev-server` config |

## Things that look like bugs and are not

- **`entryPointsFor` ignores a `browser` field that is an object.** As a map it
  is a table of redirects, applied by `browserRedirect` to whatever `main`
  names; as a string it is an entry point. Passing the map itself as a filename
  resolves to nothing and the dependency vanishes from the import map with the
  build still green. That is what `src/verify.js` is for, and there are tests
  for both halves.
- **`resolveFile` tries `.js`, `.mjs` and `/index.js`.** `main` may omit the
  extension or name a directory; jszip and friends do both.
- **`isEsm` answers "no" when a file looks like both.** Converting a module that
  did not need it costs a little startup time. Serving CommonJS as ESM is a hard
  failure in the browser with an error that points somewhere else. The bias is
  deliberate — do not "fix" it by being clever.
- **`bundleVendor` matches outputs by the entry *name*, not by stripping a
  suffix off the filename.** `cjs-dep.js` and `cjs-dep-A1B2.js` are both outputs
  of the entry named `cjs-dep`, and a regex that peels a trailing `-SOMETHING`
  off the first one leaves `cjs`. There is a test.
- **The wire-up embeds the map as a JS object literal and stringifies it at
  runtime.** That avoids escaping a JSON string inside a JS string, and it is
  what the tests parse.
- **`emitModules` minifies with `esbuild.transform`, never `build`.** Transform
  leaves every import statement intact, which is what the import map depends on.
  `build` would bundle, and the whole point is that project modules are not
  bundled.

## Testing

`bun test`. The fixture (`test/fixture.js`) writes a whole small project —
including a `node_modules` with an ESM package, a CommonJS package with an
extensionless `main`, and a package with two subpaths over shared internals —
into a temp directory per test. Generated rather than checked in: a committed
`node_modules` is both a `.gitignore` fight and a thing that rots.

`test/dev.test.js` starts a real dev server on a real port and fetches from it.
The dev half is almost entirely about what a browser receives, and the only
honest way to check that is to ask for it.

Pull requests run the suite; pushes to `main` do not, because `main` only moves
through a pull request. The other gate is the release itself.

## Releasing

Bumping `version` in `package.json` on `main` opens a draft release
(`.github/workflows/draft-release.yml`). Publishing that draft creates the tag
and publishes to npm (`.github/workflows/publish.yml`), after re-running the
tests and checking the tag matches `package.json`. Requires an `NPM_TOKEN`
repository secret with publish rights on the `@3sln` scope.
