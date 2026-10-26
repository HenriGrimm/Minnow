import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  holdPreviewGuestHidden,
  releasePreviewGuestHidden,
  resetPreviewGuestVisibilityForTests,
  resetPreviewHideHoldsForTests,
  syncElectronPreviewHostLayout,
} from '../../src/ui/preview-electron-visibility';
import {
  markPreviewOccluder,
  PREVIEW_OCCLUDER_CLASS,
  resetPreviewOcclusionForTests,
  type PreviewOccluderKind,
} from '../../src/ui/preview-occlusion';
import {
  noteHostBoundsChanged,
  startPreviewFrameCache,
  showCachedPreviewFrame,
} from '../../src/ui/preview-popover-snapshot';
import {
  bindPreviewInstanceToElement,
  resetPreviewInstanceHostsForTests,
  syncPreviewInstanceBounds,
} from '../../src/ui/preview-instance-host';
import { DEFAULT_FILE_PANEL_STATE, resetFilePanelStateForTests, setFilePanelState } from '../../src/state/file-panel';

const originals = new Map<string, PropertyDescriptor | undefined>();
const rects = new Map<string, DOMRectReadOnly>();
let win: Window;

function setGlobal(key: string, value: unknown): void {
  if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

function box(left: number, top: number, width: number, height: number): DOMRectReadOnly {
  return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height } as DOMRectReadOnly;
}

function contains(rect: DOMRectReadOnly, x: number, y: number): boolean {
  return x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height;
}

function visibleFrame(host: Element): HTMLImageElement | null {
  const image = host.querySelector<HTMLImageElement>('img.preview-popover-snapshot');
  return image && !image.hidden ? image : null;
}

function setup(placeholder: () => Promise<string> = async () => 'anBn') {
  win = new Window();
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = '<div id="appBody"><div id="previewPane"><div id="previewBody"></div></div></div><div id="reefHost"></div>';
  doc.documentElement.dataset.osApp = 'code';
  const body = doc.getElementById('previewBody')!;
  const reefHost = doc.getElementById('reefHost')!;
  rects.clear();
  rects.set('previewBody', box(400, 0, 400, 300));
  rects.set('reefHost', box(0, 400, 300, 300));
  body.getBoundingClientRect = () => rects.get('previewBody')!;
  reefHost.getBoundingClientRect = () => rects.get('reefHost')!;
  win.HTMLImageElement.prototype.decode = async () => {};

  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  setGlobal('window', win);
  setGlobal('document', doc);
  setGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++id, cb); return id; });
  setGlobal('cancelAnimationFrame', (handle: number) => frames.delete(handle));
  setGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} });

  const actions: string[] = [];
  (win as unknown as { minnow: unknown }).minnow = { preview: {
    capturePage: async () => { actions.push('capture'); return 'cG5n'; },
    capturePlaceholder: async () => { actions.push('placeholder'); return placeholder(); },
    show: async (_bounds: unknown, _tab: unknown, instance?: string) => { actions.push(instance ? `show:${instance}` : 'show'); },
    hide: async (_tab: unknown, instance?: string) => {
      if (instance) actions.push(`hide:${instance}`);
      else actions.push(visibleFrame(body) ? 'hide-with-frame' : 'hide');
    },
  } };
  setFilePanelState({ ...DEFAULT_FILE_PANEL_STATE, rightPaneMode: 'preview' });

  // Overlays added by a test paint above everything; anything else hits the document body.
  resetPreviewOcclusionForTests({
    getRect: (element) => rects.get(element.id) ?? box(0, 0, 0, 0),
    hitTest: (x, y) => {
      const overlays = Array.from(doc.getElementsByClassName(PREVIEW_OCCLUDER_CLASS)).reverse();
      return overlays.find((overlay) => contains(rects.get(overlay.id) ?? box(0, 0, 0, 0), x, y)) ?? doc.body;
    },
  });

  const addOverlay = (overlayId: string, rect: DOMRectReadOnly, kind: PreviewOccluderKind = 'menu'): HTMLElement => {
    const overlay = doc.createElement('div');
    overlay.id = overlayId;
    markPreviewOccluder(overlay, kind);
    rects.set(overlayId, rect);
    doc.body.appendChild(overlay);
    return overlay;
  };

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      const queued = [...frames.values()];
      frames.clear();
      queued.forEach((cb) => cb(0));
    }
  };
  const sync = async (): Promise<void> => {
    const pending = syncElectronPreviewHostLayout();
    await flush();
    await pending;
    await flush();
  };
  return { doc, body, reefHost, actions, addOverlay, flush, sync };
}

afterEach(async () => {
  resetPreviewInstanceHostsForTests();
  resetPreviewGuestVisibilityForTests();
  resetPreviewHideHoldsForTests();
  resetPreviewOcclusionForTests();
  resetFilePanelStateForTests();
  await win?.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});

test('a menu away from the preview leaves the live guest shown', async () => {
  const { actions, addOverlay, sync } = setup();
  await sync();
  assert.ok(actions.includes('show'));
  addOverlay('menu', box(0, 0, 100, 100));
  await sync();
  assert.ok(!actions.some((action) => action.startsWith('hide')));
});

test('an overlapping menu reveals the cached frame before the guest hides, and closing it restores the guest', async () => {
  const { body, actions, addOverlay, sync } = setup();
  await sync();
  assert.ok(actions.includes('placeholder'));

  const menu = addOverlay('menu', box(500, 0, 100, 100));
  await sync();
  assert.equal(actions.at(-1), 'hide-with-frame');
  // The cached frame made an on-demand capture unnecessary.
  assert.ok(!actions.includes('capture'));
  assert.ok(visibleFrame(body)?.getAttribute('src')?.startsWith('data:image/jpeg;base64,'));

  menu.remove();
  await sync();
  assert.equal(actions.at(-1), 'show');
  assert.ok(!visibleFrame(body));
});

test('a force-hide hold hides the guest without any overlay', async () => {
  const { actions, sync } = setup();
  await sync();
  holdPreviewGuestHidden();
  await sync();
  assert.ok(actions.at(-1)?.startsWith('hide'));
  releasePreviewGuestHidden();
  await sync();
  assert.equal(actions.at(-1), 'show');
});

test('a notification over the page shows the paused message; a menu does not', async () => {
  const { body, addOverlay, sync } = setup();
  await sync();
  const toast = addOverlay('toast', box(600, 200, 300, 80), 'notification');
  await sync();
  const paused = body.querySelector<HTMLElement>('.preview-paused');
  assert.ok(paused && !paused.hidden);
  assert.equal(paused.querySelector('.preview-paused__heading')?.textContent, 'Paused while a notification is open');

  toast.remove();
  await sync();
  assert.ok(paused.hidden);

  addOverlay('menu', box(500, 0, 100, 100));
  await sync();
  assert.ok(paused.hidden);
});

test('the frame cache never captures while the guest is hidden', async () => {
  const { body, actions, flush } = setup();
  const stop = startPreviewFrameCache(body, { isGuestVisible: () => false });
  await flush();
  assert.ok(!actions.includes('placeholder'));
  stop();
});

test('a recent host resize skips the capture tick', async () => {
  const { body, actions, flush } = setup();
  noteHostBoundsChanged(body);
  const stop = startPreviewFrameCache(body, { isGuestVisible: () => true });
  await flush();
  assert.ok(!actions.includes('placeholder'));
  stop();
});

test('stopping the frame cache mid-capture leaves no image behind', async () => {
  let finish!: (value: string) => void;
  const { body, flush } = setup(() => new Promise((resolve) => { finish = resolve; }));
  const stop = startPreviewFrameCache(body, { isGuestVisible: () => true });
  await flush();
  stop();
  finish('anBn');
  await flush();
  assert.ok(!body.querySelector('img'));
});

test('a cached frame cannot be reused after switching tabs', async () => {
  const { body, flush } = setup();
  let source = 'tab-a';
  const stop = startPreviewFrameCache(body, { isGuestVisible: () => true, sourceKey: () => source });
  await flush();
  assert.equal(showCachedPreviewFrame(body), true);
  source = 'tab-b';
  assert.equal(showCachedPreviewFrame(body), false);
  assert.ok(!visibleFrame(body));
  stop();
});

test('a frame that resolves after a tab switch is discarded', async () => {
  let finish!: (value: string) => void;
  const { body, flush } = setup(() => new Promise((resolve) => { finish = resolve; }));
  let source = 'tab-a';
  const stop = startPreviewFrameCache(body, { isGuestVisible: () => true, sourceKey: () => source });
  source = 'tab-b';
  finish('anBn');
  await flush();
  assert.equal(showCachedPreviewFrame(body), false);
  stop();
});

test('a first cache frame arriving after occlusion becomes visible without another sync', async () => {
  let finish!: (value: string) => void;
  const { body, flush } = setup(() => new Promise((resolve) => { finish = resolve; }));
  const stop = startPreviewFrameCache(body, { isGuestVisible: () => true });
  assert.equal(showCachedPreviewFrame(body), false);
  finish('anBn');
  await flush();
  assert.ok(visibleFrame(body));
  stop();
});

test('an overlay over a bound instance host hides only that instance', async () => {
  const { reefHost, actions, addOverlay, sync, flush } = setup();
  await sync();
  bindPreviewInstanceToElement('reef', reefHost);
  assert.ok(actions.includes('show:reef'));

  addOverlay('menu', box(0, 400, 100, 100));
  syncPreviewInstanceBounds('reef');
  await flush();
  assert.ok(actions.includes('hide:reef'));
  await sync();
  assert.ok(!actions.includes('hide') && !actions.includes('hide-with-frame'));
});
