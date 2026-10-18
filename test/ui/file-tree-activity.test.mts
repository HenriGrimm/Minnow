import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { beginFileTreeActivity } from '../../src/ui/file-tree-activity.ts';

let win: Window;
beforeEach(() => {
  win = new Window();
  globalThis.document = win.document as unknown as Document;
  document.body.innerHTML = '<div id="fileTreeHost"></div>';
});
afterEach(() => win.close());

test('file operations share a local spinner until the last operation settles', () => {
  const host = document.getElementById('fileTreeHost')!;
  const first = beginFileTreeActivity('Moving files…');
  const second = beginFileTreeActivity('Importing files…');
  assert.equal(host.getAttribute('aria-busy'), 'true');
  assert.equal(host.querySelectorAll('[role="status"]').length, 1);
  assert.equal(host.querySelectorAll('.mn-action-spinner').length, 1);
  assert.match(host.textContent!, /Importing files/);
  first();
  first();
  assert.equal(host.getAttribute('aria-busy'), 'true');
  second();
  assert.equal(host.hasAttribute('aria-busy'), false);
  assert.equal(host.querySelector('[role="status"]'), null);
});

test('a file-tree repaint does not prevent operation cleanup', () => {
  const host = document.getElementById('fileTreeHost')!;
  const finish = beginFileTreeActivity('Updating files…');
  host.replaceChildren();
  const next = beginFileTreeActivity('Creating file…');
  assert.equal(host.querySelectorAll('[role="status"]').length, 1);
  finish();
  next();
  assert.equal(host.hasAttribute('aria-busy'), false);
});

test('absent file tree needs no global progress notification', () => {
  document.body.replaceChildren();
  beginFileTreeActivity('Updating files…')();
  assert.equal(document.querySelector('.mn-toast'), null);
});
