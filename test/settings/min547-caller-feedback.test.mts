import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { Window } from 'happy-dom';
import { readFileSync, readdirSync } from 'node:fs';
import { runSettingsAction } from '../../src/ui/settings-controls.ts';

let win: Window | undefined;
afterEach(async () => { await win?.happyDOM.close(); });

function setup() {
  win = new Window();
  Object.assign(globalThis, { window: win, document: win.document });
  const button = win.document.createElement('button');
  button.textContent = 'Install';
  win.document.body.append(button);
  return button as unknown as HTMLButtonElement;
}

test('busy actions stay local, prevent duplicates, and restore child nodes', async () => {
  const button = setup();
  const icon = document.createElement('span');
  button.append(icon);
  let finish!: () => void;
  let calls = 0;
  const pending = runSettingsAction(button, 'Installing…', async () => {
    calls++;
    await new Promise<void>((resolve) => { finish = resolve; });
  });
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(button.textContent, 'Installing…');
  assert.equal(document.querySelector('.mn-toast'), null);
  await runSettingsAction(button, 'Again', async () => { calls++; });
  assert.equal(calls, 1);
  finish();
  await pending;
  assert.equal(button.disabled, false);
  assert.equal(button.hasAttribute('aria-busy'), false);
  assert.equal(button.textContent, 'Install');
  assert.equal(button.lastChild, icon);
  assert.equal(document.querySelector('.mn-toast'), null);
});

test('failed actions restore controls and surface the error', async () => {
  const button = setup();
  button.disabled = true;
  await runSettingsAction(button, 'Working…', async () => { throw new Error('Install failed'); });
  assert.equal(button.disabled, true);
  assert.equal(button.hasAttribute('aria-busy'), false);
  assert.equal(button.textContent, 'Install');
  assert.equal(document.querySelector('.mn-toast__message')?.textContent, 'Install failed');
});

test('settings callers do not publish routine success or global progress', () => {
  const root = new URL('../../src/ui/', import.meta.url);
  const files = readdirSync(root).filter((name) =>
    /^settings.*\.ts$|^editor.*-settings\.ts$|^lsp-settings\.ts$/.test(name));
  for (const file of files) {
    assert.doesNotMatch(readFileSync(new URL(file, root), 'utf8'), /setStatus\(\s*'(?:ok|spin)'/, file);
  }
});
