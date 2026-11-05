import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { configurePreviewSession } from '../../electron/dist/preview-session.js';
import electron from 'electron';

test('native preview preserves the origin of app POSTs and refuses the shell listener', {
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && 'requires a display or Xvfb',
}, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-electron-origin-'));
  const env = { ...process.env, MINNOW_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const fixture = fileURLToPath(new URL('../fixtures/electron-preview-origin.cjs', import.meta.url));
    await promisify(execFile)(electron, [fixture, home], { env, windowsHide: true, timeout: 30_000 });
  } finally {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

describe('preview session headers', () => {
  test('blocks the resolved shell listener including loopback aliases but permits project servers', async () => {
    let inspect;
    configurePreviewSession({
      webRequest: { onBeforeRequest(fn) { inspect = fn; } },
      async resolveHost(host) {
        return { endpoints: (host === 'example.org' ? ['192.0.2.1'] : ['192.0.2.1', '127.0.0.1']).map(address => ({ address })) };
      },
    }, 'http://127.0.0.1:9473/');
    for (const [url, expected] of [
      ['http://localhost:9473/', true], ['http://[::1]:9473/', true], ['ws://127.0.0.1:9473/socket', true],
      ['ws://mapped.example:9473/hmr?token=x', true], ['http://localhost.:9473/?raw', true],
      ['http://project.localhost.:9473/?raw', true], ['http://[::ffff:7f00:1]:9473/?raw', true],
      ['http://0.0.0.0:9473/', true], ['http://127.42.0.1:9473/', true],
      ['http://localhost:3000/', false], ['http://example.org:9473/', false],
      ['http://127.0.0.1:43210/p/test', false], ['devtools://devtools/bundled/', false],
    ]) {
      const result = await new Promise(resolve => inspect({ url }, resolve));
      assert.equal(result.cancel, expected, url);
    }
  });
});
