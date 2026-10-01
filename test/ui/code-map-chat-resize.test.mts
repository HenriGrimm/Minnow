import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { bindCodeMapChatResize } from '../../src/ui/code-map/chat-resize.ts';

let win: Window;
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; win.happyDOM.abort(); });

function setup(containerWidth = 1200, saved?: number) {
  win = new Window();
  Object.assign(globalThis, { window: win, document: win.document, localStorage: win.localStorage });
  if (saved) localStorage.setItem('minnow.codeMapChatWidth', String(saved));
  const root = document.createElement('div');
  const sidebar = document.createElement('aside');
  sidebar.id = 'chat';
  root.append(sidebar);
  document.body.append(root);
  Object.defineProperty(root, 'clientWidth', { value: containerWidth });
  sidebar.getBoundingClientRect = () => ({ width: 480 }) as DOMRect;
  dispose = bindCodeMapChatResize(root, sidebar);
  const handle = root.querySelector<HTMLElement>('[role=separator]')!;
  let captured = false;
  handle.setPointerCapture = () => { captured = true; };
  handle.hasPointerCapture = () => captured;
  handle.releasePointerCapture = () => { captured = false; };
  const pointer = (type: string, x: number) => handle.dispatchEvent(new win.PointerEvent(type, {
    clientX: x, button: 0, pointerId: 1,
  }));
  return { root, handle, pointer };
}

test('dragging left widens the chat and release flushes the last position before saving', () => {
  const { root, handle, pointer } = setup();
  pointer('pointerdown', 720);
  pointer('pointermove', 520);
  pointer('pointerup', 520);
  assert.equal(root.style.getPropertyValue('--code-map-chat-width'), '680px');
  assert.equal(localStorage.getItem('minnow.codeMapChatWidth'), '680');
  assert.equal(handle.getAttribute('aria-valuenow'), '680');
  assert.equal(root.classList.contains('code-brain-map-root--resizing'), false);
});

test('keyboard resizing and restored preferences respect the map and chat minimums', () => {
  const { root, handle } = setup(1200, 2000);
  assert.equal(root.style.getPropertyValue('--code-map-chat-width'), '900px');
  handle.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Home' }));
  assert.equal(root.style.getPropertyValue('--code-map-chat-width'), '320px');
  handle.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowLeft' }));
  assert.equal(root.style.getPropertyValue('--code-map-chat-width'), '344px');
  handle.dispatchEvent(new win.MouseEvent('dblclick'));
  assert.equal(localStorage.getItem('minnow.codeMapChatWidth'), '480');
});

test('closing while dragging releases the handle and stops frame updates', () => {
  const { root, handle, pointer } = setup();
  pointer('pointerdown', 720);
  pointer('pointermove', 620);
  dispose!();
  dispose = undefined;
  assert.equal(root.contains(handle), false);
  assert.equal(root.style.getPropertyValue('--code-map-chat-width'), '');
  assert.equal(root.classList.contains('code-brain-map-root--resizing'), false);
});

test('the stacked narrow layout does not start a horizontal drag', () => {
  const { root, pointer } = setup(600);
  pointer('pointerdown', 480);
  pointer('pointermove', 320);
  pointer('pointerup', 320);
  assert.equal(root.style.getPropertyValue('--code-map-chat-width'), '');
  assert.equal(localStorage.getItem('minnow.codeMapChatWidth'), null);
});
