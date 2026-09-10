import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const watchdogPath = fileURLToPath(new URL('../../server/agent-browser/watchdog.js', import.meta.url));

function exited(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

test('watchdog kills its browser when the owning server process disappears', { timeout: 15_000 }, async (t) => {
  const browser = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  t.after(() => {
    try { browser.kill('SIGKILL'); } catch {}
  });
  assert.ok(browser.pid);

  const helperSource = `
    const { spawn } = require('node:child_process');
    const watcher = spawn(process.execPath, [process.argv[1], String(process.pid), process.argv[2]], {
      detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    watcher.on('error', () => {});
    watcher.unref();
    watcher.channel?.unref?.();
  `;
  const helper = spawn(process.execPath, ['-e', helperSource, watchdogPath, String(browser.pid)], {
    windowsHide: true,
    stdio: 'ignore',
  });
  assert.equal(await exited(helper, 5_000), true, 'helper parent should exit');
  assert.equal(await exited(browser, 7_000), true, 'watchdog should terminate the orphan browser');
});
