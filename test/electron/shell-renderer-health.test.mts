import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { BrowserWindow } from 'electron';
import { wireShellRendererHealth } from '../../electron/shell-renderer-health.ts';

const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const events: Array<{ kind: string; rendererPid: number }> = [];
  const prompts: Array<{ signal: AbortSignal; answer: (value: boolean) => void }> = [];
  const state = { visible: true, pid: 401, restarts: 0 };
  const contents = Object.assign(new EventEmitter(), {
    id: 2,
    isDestroyed: () => false,
    getOSProcessId: () => state.pid,
    forcefullyCrashRenderer: () => { state.restarts++; contents.emit('render-process-gone'); },
  });
  const win = Object.assign(new EventEmitter(), {
    id: 1, webContents: contents, isDestroyed: () => false, isVisible: () => state.visible, isMinimized: () => false,
  });
  const offerRestart = wireShellRendererHealth(win as unknown as BrowserWindow, {
    isQuitting: () => false,
    confirmRestart: signal => new Promise<boolean>(answer => prompts.push({ signal, answer })),
    record: (kind, { rendererPid }) => events.push({ kind, rendererPid }),
  });
  return { win, contents, events, prompts, state, offerRestart };
}

test('short stalls and repeated notifications do not open native recovery', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { contents, events, prompts, offerRestart } = fixture();
  contents.emit('unresponsive');
  contents.emit('unresponsive');
  assert.equal(offerRestart(), false);
  t.mock.timers.tick(12_000);
  contents.emit('responsive');
  t.mock.timers.tick(5_000);
  assert.deepEqual(events, [{ kind: 'unresponsive', rendererPid: 401 }, { kind: 'responsive', rendererPid: 401 }]);
  assert.equal(prompts.length, 0);
});

test('a sustained stall waits for the workspace to be visible and restarts only on selection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { win, contents, events, prompts, state, offerRestart } = fixture();
  state.visible = false;
  contents.emit('unresponsive');
  t.mock.timers.tick(15_000);
  assert.equal(prompts.length, 0);
  state.visible = true;
  win.emit('focus');
  assert.equal(offerRestart(), true);
  assert.equal(prompts.length, 1);
  prompts[0].answer(false);
  await settle();
  assert.equal(state.restarts, 0);
  assert.equal(offerRestart(), true);
  prompts[1].answer(true);
  await settle();
  assert.equal(state.restarts, 1);
  assert.equal(offerRestart(), false);
  assert.deepEqual(events.map(x => x.kind), ['unresponsive', 'unresponsive-sustained', 'restart-unresponsive-renderer']);
});

test('recovery or a replacement document invalidates an open restart prompt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const event of ['responsive', 'did-start-navigation', 'render-process-gone', 'destroyed']) {
    const { contents, prompts, state } = fixture();
    contents.emit('unresponsive');
    t.mock.timers.tick(15_000);
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    assert.equal(prompts[0].signal.aborted, false);
    contents.emit(event, { isMainFrame: true, isSameDocument: false });
    assert.equal(prompts[0].signal.aborted, true, event);
    prompts[0].answer(true);
    await settle();
    assert.equal(state.restarts, 0, event);
  }
});
