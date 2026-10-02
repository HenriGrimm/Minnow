import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { registerChromePopover, unregisterChromePopover, resetChromePopoverRegistryForTests,
  resetPreviewGuestVisibilityForTests, syncElectronPreviewHostLayout } from '../../src/ui/preview-electron-visibility';
import { DEFAULT_FILE_PANEL_STATE, resetFilePanelStateForTests, setFilePanelState } from '../../src/state/file-panel';

const originals = new Map<string, PropertyDescriptor | undefined>();
let win: Window;
function setGlobal(key: string, value: unknown): void {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

function setup(capture: () => Promise<string> = async () => 'cG5n') {
  win = new Window();
  win.document.body.innerHTML = '<div id="appBody"><div id="previewPane"><div id="previewBody"></div></div></div>';
  win.document.documentElement.dataset.osApp = 'code';
  const body = win.document.getElementById('previewBody')!;
  body.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300 }) as DOMRect;
  win.HTMLImageElement.prototype.decode = async () => {};
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  setGlobal('window', win);
  setGlobal('document', win.document);
  setGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++id, cb); return id; });
  setGlobal('cancelAnimationFrame', (handle: number) => frames.delete(handle));
  const actions: string[] = [];
  (win as unknown as Window & { minnow: unknown }).minnow = { preview: {
    capturePage: async (_tab: unknown, _instance: unknown, immediate: boolean) => {
      assert.equal(immediate, true);
      actions.push('capture');
      return capture();
    },
    show: async () => { actions.push('show'); },
    hide: async () => {
      actions.push(body.querySelector('img') ? 'hide-with-snapshot' : 'hide');
    },
  } };
  setFilePanelState({ ...DEFAULT_FILE_PANEL_STATE, rightPaneMode: 'preview' });
  const sync = async () => {
    const pending = syncElectronPreviewHostLayout();
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      const queued = [...frames.values()];
      frames.clear();
      queued.forEach((cb) => cb(0));
    }
    await pending;
  };
  return { body, actions, sync };
}

afterEach(async () => {
  resetPreviewGuestVisibilityForTests();
  resetChromePopoverRegistryForTests();
  resetFilePanelStateForTests();
  await win?.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});

test('menus retain the painted page until the last menu closes, then restore the live guest', async () => {
  const { body, actions, sync } = setup();
  await sync();
  registerChromePopover();
  await sync();
  assert.deepEqual(actions, ['show', 'capture', 'hide-with-snapshot']);
  assert.equal(body.querySelector('img')?.getAttribute('src'), 'data:image/png;base64,cG5n');
  registerChromePopover();
  unregisterChromePopover();
  await sync();
  assert.equal(actions.filter((action) => action === 'capture').length, 1);
  assert.ok(body.querySelector('img'));
  unregisterChromePopover();
  await sync();
  assert.equal(actions.at(-1), 'show');
  assert.equal(body.querySelector('img'), null);
});

test('closing a menu during capture does not hide the live browser afterwards', async () => {
  let finish!: (value: string) => void;
  const { body, actions, sync } = setup(() => new Promise((resolve) => { finish = resolve; }));
  await sync();
  registerChromePopover();
  const pending = syncElectronPreviewHostLayout();
  await Promise.resolve();
  await Promise.resolve();
  unregisterChromePopover();
  finish('cG5n');
  await pending;
  assert.deepEqual(actions, ['show', 'capture']);
  assert.equal(body.querySelector('img'), null);
});

test('failed capture still hides the guest for the menu and restores it on dismissal', async () => {
  const { body, actions, sync } = setup(async () => { throw new Error('capture failed'); });
  await sync();
  registerChromePopover();
  await sync();
  assert.equal(actions.at(-1), 'hide');
  unregisterChromePopover();
  await sync();
  assert.equal(actions.at(-1), 'show');
  assert.equal(body.querySelector('img'), null);
});

test('leaving Code clears a snapshot instead of retaining stale page content', async () => {
  const { body, sync } = setup();
  await sync();
  registerChromePopover();
  await sync();
  assert.ok(body.querySelector('img'));
  win.document.documentElement.dataset.osApp = 'settings';
  await sync();
  assert.equal(body.querySelector('img'), null);
});
