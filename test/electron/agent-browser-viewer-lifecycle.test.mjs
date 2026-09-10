import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SingleViewerWindow } from '../../electron/agent-browser-viewer-lifecycle.ts';

test('SingleViewerWindow coalesces an open race and drops a closed viewer', async () => {
  const lifecycle = new SingleViewerWindow();
  let resolveOpen;
  let calls = 0;
  const open = () => {
    calls += 1;
    return new Promise((resolve) => { resolveOpen = resolve; });
  };

  const first = lifecycle.begin(open);
  const second = lifecycle.begin(open);
  assert.equal(first, second);
  assert.equal(calls, 1);
  resolveOpen({ ok: true, focused: false });
  await first;

  const win = { destroyed: false, isDestroyed() { return this.destroyed; } };
  lifecycle.set(win);
  assert.equal(lifecycle.live(), win);
  win.destroyed = true;
  assert.equal(lifecycle.live(), null);
});
