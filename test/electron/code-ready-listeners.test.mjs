import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

test('repeated Code-ready notifications do not accumulate close listeners', () => {
  const source = readFileSync(new URL('../../electron/main.ts', import.meta.url), 'utf8');
  const body = source.split('ipcMain.handle(channels.WINDOW_CODE_READY, (event) => {')[1].split('\n  });')[0];
  const win = Object.assign(new EventEmitter(), { id: 1 });
  const ready = new Set();
  const pending = new Map();
  const handler = new Function('BrowserWindow', 'shellWindows', 'codeCommandReady', 'pendingCodeCommands', 'event', body);
  for (let i = 0; i < 25; i++) {
    handler({ fromWebContents: () => win }, new Map([[1, {}]]), ready, pending, { sender: {} });
  }
  assert.equal(win.listenerCount('closed'), 0);
  assert.equal(ready.has(1), true);
  assert.match(source, /win.on\('closed', \(\) => \{\s*clearTimeout\(showFallbackTimer\);\s*codeCommandReady.delete\(win.id\);\s*pendingCodeCommands.delete\(win.id\);/);
});
