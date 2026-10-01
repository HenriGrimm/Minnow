import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installNativeSelectPreviewGuard } from '../../src/ui/native-select-preview-guard';
import { isChromePopoverOpen, registerChromePopover, unregisterChromePopover, resetChromePopoverRegistryForTests } from '../../src/ui/preview-electron-visibility';

const originals = new Map<string, PropertyDescriptor | undefined>();
let dispose: (() => void) | undefined;
let win: Window;

function setGlobal(key: string, value: unknown): void {
  if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

function setup() {
  win = new Window();
  const select = win.document.createElement('select');
  win.document.body.append(select);
  let open = false;
  const query = win.document.querySelectorAll.bind(win.document);
  win.document.querySelectorAll = ((selector: string) => selector === 'select:open'
    ? (open && select.isConnected ? [select] : []) : query(selector)) as typeof query;
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  setGlobal('window', win);
  setGlobal('document', win.document);
  setGlobal('MutationObserver', win.MutationObserver);
  setGlobal('CSS', { supports: () => true });
  setGlobal('getComputedStyle', () => ({ appearance: 'base-select' }));
  setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  setGlobal('cancelAnimationFrame', (handle: number) => frames.delete(handle));
  (win as unknown as { minnow: unknown }).minnow = { preview: {} };
  dispose = installNativeSelectPreviewGuard();
  // The guard uses the real popover registry; these tests don't mount a guest.
  (win as unknown as { minnow: unknown }).minnow = undefined;
  function flush() {
    while (frames.size) {
      const pending = [...frames];
      frames.clear();
      for (const [, callback] of pending) callback(0);
    }
  }
  return { select, flush, setOpen(value: boolean) { open = value; } };
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
  resetChromePopoverRegistryForTests();
  win?.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});

test('a styled picker registers once and closes without consuming another popover', () => {
  const { select, flush, setOpen } = setup();
  registerChromePopover();
  setOpen(true);
  select.dispatchEvent(new win.Event('focusin', { bubbles: true }));
  flush();
  select.dispatchEvent(new win.Event('keydown', { bubbles: true }));
  flush();
  setOpen(false);
  select.dispatchEvent(new win.Event('change', { bubbles: true }));
  flush();
  assert.equal(isChromePopoverOpen(), true);
  unregisterChromePopover();
  assert.equal(isChromePopoverOpen(), false);
});

test('removing an open select restores the preview even without a focus event', async () => {
  const { select, flush, setOpen } = setup();
  setOpen(true);
  select.dispatchEvent(new win.Event('focusin', { bubbles: true }));
  flush();
  assert.equal(isChromePopoverOpen(), true);
  select.remove();
  await new Promise((resolve) => setTimeout(resolve, 0));
  flush();
  assert.equal(isChromePopoverOpen(), false);
});

test('disposing an open picker releases the guard and cancels pending work', () => {
  const { select, flush, setOpen } = setup();
  setOpen(true);
  select.dispatchEvent(new win.Event('focusin', { bubbles: true }));
  flush();
  assert.equal(isChromePopoverOpen(), true);
  select.dispatchEvent(new win.Event('keydown', { bubbles: true }));
  dispose?.();
  dispose = undefined;
  flush();
  assert.equal(isChromePopoverOpen(), false);
});
