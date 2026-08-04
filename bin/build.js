#!/usr/bin/env node
//
// 3sln-build [--config <file>] [--root <dir>]
//
// For a project whose build is nothing but the config. Anything that needs to
// emit more than the client -- a static site, a service worker with the build
// id stamped into it, a headers file listing its own stable names -- should
// call `build()` from a script of its own instead.
import { build, loadConfig, BuildError } from '../src/build.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1] ?? null;
};

try {
  const config = await loadConfig({
    root: flag('root') ?? process.cwd(),
    file: flag('config'),
  });
  await build(config);
} catch (err) {
  if (err instanceof BuildError) {
    console.error(`build failed: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
