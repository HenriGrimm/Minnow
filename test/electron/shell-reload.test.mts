import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { BrowserWindow } from 'electron';
import { wireShellReload } from '../../electron/shell-reload.ts';

function shell(prepare: () => Promise<unknown>, offerRecovery?: () => boolean) {
  const contents = Object.assign(new EventEmitter(), {
    executeJavaScript: prepare,
    isDestroyed: () => false,
    reload: () => { reloads.push('normal'); },
    reloadIgnoringCache: () => { reloads.push('hard'); },
  });
  const reloads: string[] = [];
  const win = { webContents: contents, isDestroyed: () => false };
  wireShellReload(win as unknown as BrowserWindow, offerRecovery);
  let prevented = 0;
  return {
    win, reloads,
    press: (key = 'r', shift = false) => {
      contents.emit('before-input-event', { preventDefault: () => { prevented++; } }, {
        type: 'keyDown', key, shift, control: true, meta: true, alt: false,
      });
    },
    prevented: () => prevented,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('Ctrl+R waits for acknowledged persistence and coalesces repeated shortcuts', async () => {
  let finish!: (saved: boolean) => void;
  let prepares = 0;
  const fixture = shell(() => {
    prepares++;
    return new Promise((resolve) => { finish = resolve; });
  });
  fixture.press();
  fixture.press();
  assert.equal(fixture.prevented(), 2);
  assert.equal(prepares, 1);
  assert.deepEqual(fixture.reloads, []);
  finish(true);
  await settle();
  assert.deepEqual(fixture.reloads, ['normal']);
});

test('failed persistence cancels reload and permits a later retry', async () => {
  let saved = false;
  const fixture = shell(async () => saved);
  fixture.press();
  await settle();
  assert.deepEqual(fixture.reloads, []);
  saved = true;
  fixture.press('r', true);
  await settle();
  assert.deepEqual(fixture.reloads, ['hard']);
});

test('F5 is guarded and a closed window cannot reload after the save', async () => {
  let finish!: (saved: boolean) => void;
  const fixture = shell(() => new Promise((resolve) => { finish = resolve; }));
  fixture.press('F5');
  assert.equal(fixture.prevented(), 1);
  fixture.win.isDestroyed = () => true;
  finish(true);
  await settle();
  assert.deepEqual(fixture.reloads, []);
});

test('a confirmed renderer hang can be handled even while an earlier save is pending', () => {
  let prepares = 0;
  let recoveryOffers = 0;
  let hung = false;
  const fixture = shell(() => {
    prepares++;
    return new Promise(() => {});
  }, () => {
    if (!hung) return false;
    recoveryOffers++;
    return true;
  });
  fixture.press('F5');
  hung = true;
  fixture.press('F5');
  assert.equal(prepares, 1);
  assert.equal(recoveryOffers, 1);
  assert.deepEqual(fixture.reloads, []);
});

test('renderer replacement releases a stuck save and ignores its late acknowledgement', async () => {
  const prepares: Array<(saved: boolean) => void> = [];
  const fixture = shell(() => new Promise(resolve => prepares.push(resolve)));
  fixture.press();
  fixture.win.webContents.emit('render-process-gone');
  fixture.press();
  assert.equal(prepares.length, 2);
  prepares[0](true);
  await settle();
  assert.deepEqual(fixture.reloads, []);
  fixture.press();
  assert.equal(prepares.length, 2);
  prepares[1](true);
  await settle();
  assert.deepEqual(fixture.reloads, ['normal']);
});
