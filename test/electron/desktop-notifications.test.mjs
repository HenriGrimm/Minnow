import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beforeEach, mock, test } from 'node:test';

let handler;
let notifications;
let supported = true;
class FakeNotification extends EventEmitter {
  constructor(options) { super(); this.options = options; notifications.push(this); }
  static isSupported() { return supported; }
  show() { this.emit('show'); }
  close() { this.emit('close'); }
}
mock.module('electron', { namedExports: {
  Notification: FakeNotification,
  BrowserWindow: { fromWebContents: (sender) => sender.win },
} });
mock.module('../../electron/trusted-ipc.ts', { namedExports: {
  trustedIpc: { handle: (_channel, callback) => { handler = callback; } },
} });
const { registerDesktopNotificationIpc } = await import('../../electron/desktop-notifications.ts');

let sender;
let focused;
beforeEach(() => {
  notifications = [];
  supported = true;
  focused = null;
  sender = Object.assign(new EventEmitter(), {
    win: { isDestroyed: () => false },
    isDestroyed: () => false,
    sent: [],
    send(...args) { this.sent.push(args); },
  });
  registerDesktopNotificationIpc((win) => { focused = win; }, 'minnow.png');
});
const input = { id: 'toast-1', title: 'Chat', body: 'Done', tag: 'chat-1' };

test('native notification restores its owning window and routes clicks', async () => {
  assert.deepEqual(await handler({ sender }, input), { ok: true });
  assert.equal(notifications[0].options.silent, true);
  notifications[0].emit('click');
  assert.equal(focused, sender.win);
  assert.ok(sender.sent.some((event) => event[1] === input.id && event[2] === 'click'));
});

test('OS failure is returned to the renderer', async () => {
  const original = FakeNotification.prototype.show;
  FakeNotification.prototype.show = function () { this.emit('failed', {}, 'Toast registration failed'); };
  try {
    assert.deepEqual(await handler({ sender }, input), { ok: false, error: 'Toast registration failed' });
  } finally { FakeNotification.prototype.show = original; }
});

test('unsupported platforms and invalid IPC inputs are reported', async () => {
  assert.equal((await handler({ sender }, { ...input, title: null })).ok, false);
  supported = false;
  assert.match((await handler({ sender }, input)).error, /unavailable/);
  assert.equal(notifications.length, 0);
});

test('repeated alerts replace the same tag without accumulating window listeners', async () => {
  for (let i = 0; i < 25; i++) await handler({ sender }, { ...input, id: `toast-${i}` });
  assert.equal(sender.listenerCount('destroyed'), 1);
  assert.equal(sender.sent.filter((event) => event[2] === 'close').length, 24);
  sender.emit('destroyed');
  assert.equal(sender.sent.filter((event) => event[2] === 'close').length, 25);
});

test('unconfirmed delivery times out and cleans up the native toast', async () => {
  const original = FakeNotification.prototype.show;
  FakeNotification.prototype.show = function () {};
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const delivery = handler({ sender }, input);
    mock.timers.tick(5000);
    assert.match((await delivery).error, /did not confirm/);
    assert.equal(sender.sent.filter((event) => event[2] === 'close').length, 1);
  } finally {
    mock.timers.reset();
    FakeNotification.prototype.show = original;
  }
});
