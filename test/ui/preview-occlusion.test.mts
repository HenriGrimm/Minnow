import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  createPreviewOcclusionTracker,
  markPreviewOccluder,
  unmarkPreviewOccluder,
  PREVIEW_OCCLUDER_HIT_EXCLUDE_CLASS,
} from '../../src/ui/preview-occlusion';

let win: Window;
let doc: Document;
let host: HTMLElement;
let hostChild: HTMLElement;
const frames: FrameRequestCallback[] = [];
const rects = new Map<string, DOMRectReadOnly>();
const originalRaf = globalThis.requestAnimationFrame;

function box(left: number, top: number, width: number, height: number): DOMRectReadOnly {
  return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height } as DOMRectReadOnly;
}

function getRect(element: Element): DOMRectReadOnly {
  return rects.get(element.id) ?? box(0, 0, 0, 0);
}

function addOverlay(id: string, kind: 'menu' | 'notification' = 'menu'): HTMLElement {
  const overlay = doc.createElement('div');
  overlay.id = id;
  overlay.innerHTML = `<button id="${id}Item">Item</button>`;
  markPreviewOccluder(overlay, kind);
  doc.body.appendChild(overlay);
  return overlay;
}

function flushMutations(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function runFrames(): number {
  const queued = frames.splice(0);
  queued.forEach((callback) => callback(0));
  return queued.length;
}

beforeEach(() => {
  win = new Window();
  doc = win.document as unknown as Document;
  doc.body.innerHTML = '<div id="host"><span id="hostChild"></span></div>';
  host = doc.getElementById('host')!;
  hostChild = doc.getElementById('hostChild')!;
  rects.clear();
  rects.set('host', box(200, 0, 400, 300));
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  }) as typeof requestAnimationFrame;
});

afterEach(async () => {
  frames.length = 0;
  globalThis.requestAnimationFrame = originalRaf;
  await win.happyDOM.close();
});

test('no marked overlays reports nothing', () => {
  const tracker = createPreviewOcclusionTracker({ doc, getRect, hitTest: () => null });
  assert.deepEqual(tracker.getOverlaps(host), []);
});

test('a marked menu that does not intersect the host is ignored without hit-testing', () => {
  addOverlay('menu');
  rects.set('menu', box(0, 0, 100, 100));
  let hitTests = 0;
  const tracker = createPreviewOcclusionTracker({ doc, getRect, hitTest: () => { hitTests += 1; return null; } });
  assert.deepEqual(tracker.getOverlaps(host), []);
  assert.equal(hitTests, 0);
});

test('an intersecting menu painted on top is reported with its kind', () => {
  addOverlay('menu');
  rects.set('menu', box(150, 0, 100, 100));
  const points: Array<[number, number]> = [];
  const tracker = createPreviewOcclusionTracker({
    doc,
    getRect,
    hitTest: (x, y) => { points.push([x, y]); return doc.getElementById('menuItem'); },
  });
  const overlaps = tracker.getOverlaps(host);
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0]!.kind, 'menu');
  assert.equal(overlaps[0]!.element.id, 'menu');
  // Centre of the intersection {200..250, 0..100}.
  assert.deepEqual(points, [[225, 50]]);
});

test('an intersecting menu painted underneath the host is not reported', () => {
  addOverlay('menu');
  rects.set('menu', box(150, 0, 100, 100));
  const tracker = createPreviewOcclusionTracker({ doc, getRect, hitTest: () => hostChild });
  assert.deepEqual(tracker.getOverlaps(host), []);
});

test('hit-testing looks through transparent click-catcher layers', () => {
  addOverlay('menu');
  rects.set('menu', box(150, 0, 100, 100));
  const catcher = doc.createElement('div');
  catcher.className = PREVIEW_OCCLUDER_HIT_EXCLUDE_CLASS;
  doc.body.appendChild(catcher);
  let below: Element = doc.getElementById('menuItem')!;
  Object.defineProperty(doc, 'elementFromPoint', { configurable: true, value: () => catcher });
  Object.defineProperty(doc, 'elementsFromPoint', { configurable: true, value: () => [catcher, below] });
  const tracker = createPreviewOcclusionTracker({ doc, getRect });
  assert.equal(tracker.getOverlaps(host).length, 1);
  below = hostChild;
  assert.deepEqual(tracker.getOverlaps(host), []);
});

test('a marked backdrop that contains the host is not an overlap', () => {
  const backdrop = doc.createElement('div');
  backdrop.id = 'backdrop';
  markPreviewOccluder(backdrop, 'dialog');
  doc.body.appendChild(backdrop);
  backdrop.appendChild(host);
  rects.set('backdrop', box(0, 0, 1000, 800));
  const tracker = createPreviewOcclusionTracker({ doc, getRect, hitTest: () => hostChild });
  assert.deepEqual(tracker.getOverlaps(host), []);
});

test('subscribers hear one coalesced frame per overlay change and nothing after unsubscribing', async () => {
  const tracker = createPreviewOcclusionTracker({ doc, getRect, hitTest: () => null });
  let calls = 0;
  const unsubscribe = tracker.subscribe(() => { calls += 1; });
  addOverlay('menu');
  addOverlay('toast', 'notification');
  await flushMutations();
  assert.equal(runFrames(), 1);
  assert.equal(calls, 1);

  unsubscribe();
  addOverlay('later');
  await flushMutations();
  runFrames();
  assert.equal(calls, 1);
});

test('unrelated DOM churn does not notify subscribers', async () => {
  const tracker = createPreviewOcclusionTracker({ doc, getRect, hitTest: () => null });
  let calls = 0;
  tracker.subscribe(() => { calls += 1; });
  doc.body.appendChild(doc.createElement('p'));
  await flushMutations();
  runFrames();
  assert.equal(calls, 0);
});

test('marking and unmarking an already-mounted panel notifies on every reopen', async () => {
  const menu = doc.createElement('div');
  doc.body.appendChild(menu);
  const tracker = createPreviewOcclusionTracker({ doc, getRect, hitTest: () => menu });
  let calls = 0;
  const unsubscribe = tracker.subscribe(() => { calls += 1; });
  for (let i = 0; i < 2; i++) {
    markPreviewOccluder(menu, 'menu');
    await flushMutations();
    runFrames();
    unmarkPreviewOccluder(menu);
    await flushMutations();
    runFrames();
  }
  assert.equal(calls, 4);
  unsubscribe();
});

test('restyling a marked overlay invalidates its cached rect', async () => {
  const menu = addOverlay('menu');
  rects.set('menu', box(150, 0, 100, 100));
  let menuRectReads = 0;
  const tracker = createPreviewOcclusionTracker({
    doc,
    getRect: (element) => { if (element.id === 'menu') menuRectReads += 1; return getRect(element); },
    hitTest: () => doc.getElementById('menuItem'),
  });
  tracker.subscribe(() => {});
  tracker.getOverlaps(host);
  tracker.getOverlaps(host);
  assert.equal(menuRectReads, 1);

  menu.setAttribute('style', 'left: 10px');
  await flushMutations();
  tracker.getOverlaps(host);
  assert.equal(menuRectReads, 2);
});
