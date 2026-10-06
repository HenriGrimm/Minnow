/**
 * The bundled `minnow run` entry an installed build ships. It has to load with
 * nothing beside it — no node_modules, no tsx, no TypeScript sources.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { buildHeadlessRunner } from '../../scripts/build-headless-runner.mjs';

let dir;
let bundle;
let externals;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-headless-bundle-'));
  ({ outfile: bundle, externals } = await buildHeadlessRunner({
    outfile: path.join(dir, 'minnow-run.mjs'),
    logLevel: 'error',
  }));
});

after(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

function runBundle(args) {
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd: dir,
    env: { ...process.env, MINNOW_HOME: dir, MINNOW_TOKEN: '' },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

test('bundle imports only Node builtins', () => {
  assert.ok(externals.length > 0);
  assert.deepEqual(externals.filter((name) => !isBuiltin(name)), []);
});

test('bundle starts outside the repo and prints run help', () => {
  const result = runBundle(['run', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /minnow run — execute one agent turn/);
});

test('bundle reaches the preflight and reports an unreachable server', () => {
  const result = runBundle(['run', '--json', '--prompt', 'hi', '--base-url', 'http://127.0.0.1:9']);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /Server not reachable at http:\/\/127\.0\.0\.1:9/);
});
