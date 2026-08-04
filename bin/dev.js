#!/usr/bin/env node
//
// 3sln-dev [--config <file>] [--root <dir>] [--port <n>] [--open]
//
// The same config the build reads, served live. A project that needs to mount
// extra routes -- a landing page, docs rendered on the fly -- should write a
// web-dev-server.config.js calling `devServer(config, {middleware})` instead.
import { startDevServer } from '@web/dev-server';
import { loadConfig } from '../src/config.js';
import { devServerConfig } from '../src/dev/server.js';
import { BuildError } from '../src/util.js';

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
  const port = flag('port');
  await startDevServer({
    config: devServerConfig(config, {
      ...(port ? { port: Number(port) } : {}),
      open: args.includes('--open'),
    }),
    readCliArgs: false,
    readFileConfig: false,
  });
} catch (err) {
  if (err instanceof BuildError) {
    console.error(`dev server failed to start: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
