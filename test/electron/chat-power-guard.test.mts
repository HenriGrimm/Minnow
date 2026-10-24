import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { WebContents } from 'electron';
import { createChatPowerGuard, wireChatPowerGuard } from '../../electron/chat-power-guard.ts';

function fixture() {
  const live = new Set<number>();
  const started: string[] = [];
  const stopped: number[] = [];
  const guard = createChatPowerGuard({
    start(type) {
      const id = started.length;
      started.push(type);
      live.add(id);
      return id;
    },
    isStarted: (id) => live.has(id),
    stop(id) {
      stopped.push(id);
      return live.delete(id);
    },
  });
  return { guard, live, started, stopped };
}

test('uses one system-only blocker until the last active workspace releases it', () => {
  const { guard, live, started, stopped } = fixture();
  guard.setActive(1, false);
  assert.deepEqual(started, []);
  guard.setActive(1, true);
  guard.setActive(1, true);
  guard.setActive(2, true);
  assert.deepEqual(started, ['prevent-app-suspension']);
  guard.setActive(1, false);
  guard.setActive(1, false);
  guard.setActive(99, false);
  assert.equal(live.size, 1);
  assert.deepEqual(stopped, []);
  guard.setActive(2, false);
  assert.equal(live.size, 0);
  assert.deepEqual(stopped, [0]);
  guard.setActive(1, true);
  assert.equal(live.size, 1);
  assert.equal(started.length, 2);
});

test('recovers an externally stopped blocker and disposes all claims on quit', () => {
  const { guard, live, started, stopped } = fixture();
  guard.setActive(1, true);
  live.clear();
  guard.setActive(2, true);
  assert.equal(started.length, 2);
  guard.dispose();
  guard.dispose();
  assert.equal(live.size, 0);
  assert.deepEqual(stopped, [1]);
  guard.setActive(3, true);
  guard.setActive(3, false);
  assert.equal(live.size, 0);
});

for (const event of ['render-process-gone', 'destroyed', 'did-start-navigation']) {
  test(`${event} releases only that renderer's claim`, () => {
    const { guard, live } = fixture();
    const contents = Object.assign(new EventEmitter(), { id: 1 });
    wireChatPowerGuard(contents as unknown as WebContents, guard);
    guard.setActive(1, true);
    guard.setActive(2, true);
    contents.emit(event, { isMainFrame: true, isSameDocument: false });
    assert.equal(live.size, 1);
    guard.setActive(2, false);
    assert.equal(live.size, 0);
  });
}

test('hash routes, subframes and backgrounding do not release a running chat', () => {
  const { guard, live } = fixture();
  const contents = Object.assign(new EventEmitter(), { id: 1 });
  wireChatPowerGuard(contents as unknown as WebContents, guard);
  guard.setActive(1, true);
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  contents.emit('hide');
  assert.equal(live.size, 1);
  contents.emit('render-process-gone');
  contents.emit('destroyed');
  assert.equal(live.size, 0);
});
