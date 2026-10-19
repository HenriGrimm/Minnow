#!/usr/bin/env node
/**
 * Rebuild the SPA into <outDir> on every source change, for phones on the dev
 * server's remote listeners (see server/remote/dev-remote-bundle.js). Runs as a
 * child so rebuilds never stall the dev server's event loop.
 *
 * Usage: node scripts/remote-bundle-watch.mjs <outDir>
 * stdout: one JSON line per build — {"event":"built","ms":N} or {"event":"error","message":"…"}
 * Exits when stdin closes (the dev server went away).
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: remote-bundle-watch.mjs <outDir>');
  process.exit(2);
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

const watcher = await build({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  logLevel: 'warn',
  build: {
    outDir,
    // Old hashed chunks stay until the next dev-server start: a phone that loaded
    // the previous index.html can still fetch what it references mid-rebuild.
    emptyOutDir: false,
    watch: {},
  },
});

let started = Date.now();
watcher.on('event', (event) => {
  if (event.code === 'BUNDLE_START') started = Date.now();
  if (event.code === 'BUNDLE_END') event.result?.close?.();
  if (event.code === 'END') emit({ event: 'built', ms: Date.now() - started });
  if (event.code === 'ERROR') {
    event.result?.close?.();
    emit({ event: 'error', message: String(event.error?.message ?? event.error) });
  }
});

process.stdin.resume();
process.stdin.on('end', () => {
  void watcher.close().finally(() => process.exit(0));
});
