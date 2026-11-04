import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { mountHistoryPager } from '../../src/ui/history-pager.ts';
import { initRenderIdleTracking } from '../../src/boot/render-idle.ts';

let cleanup;
afterEach(() => cleanup?.());

function setup({ from = 90, invisible = () => false, viewport = 600, top: initialTop, rowHeight = 100 } = {}) {
  const win = new Window();
  globalThis.window = win;
  globalThis.document = win.document;
  const root = document.createElement('div');
  const mount = root.appendChild(document.createElement('div'));
  document.body.append(root);
  const renderRow = (host, index) => {
    if (invisible(index)) return;
    const row = document.createElement('div');
    row.textContent = `Message ${index}`;
    host.append(row);
  };
  for (let i = from; i < from + 30; i++) renderRow(mount, i);
  let top = initialTop ?? Math.max(0, mount.children.length * rowHeight - viewport);
  Object.defineProperties(root, {
    clientHeight: { value: viewport },
    scrollHeight: { get: () => mount.children.length * rowHeight },
    scrollTop: {
      get: () => top,
      set: value => { top = Math.max(0, Math.min(value, root.scrollHeight - viewport)); },
    },
  });
  let handle = 0;
  const frames = new Map();
  win.requestAnimationFrame = callback => { frames.set(++handle, callback); return handle; };
  win.cancelAnimationFrame = id => frames.delete(id);
  const dispose = mountHistoryPager({ mount, from, scrollRoot: () => root, renderRow });
  cleanup = () => { dispose(); win.close(); };
  const scroll = value => {
    root.scrollTop = value;
    root.dispatchEvent(new win.Event('scroll'));
  };
  const wheel = deltaY => root.dispatchEvent(new win.WheelEvent('wheel', { deltaY }));
  const flush = () => {
    for (let count = 0; frames.size; count++) {
      assert.ok(count < 100, 'paging must stop once its buffer is filled');
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    }
  };
  return { win, root, mount, frames, scroll, wheel, flush, dispose };
}

test('opening an adequately buffered transcript leaves older history unmounted and has no load button', () => {
  const { root, mount, flush, frames } = setup();
  flush();
  assert.equal(frames.size, 0);
  assert.equal(mount.children.length, 30);
  assert.equal(root.querySelector('button'), null);
  assert.equal(mount.dataset.historyStart, '90');
});

test('native upward scrolling preloads two screens before the boundary is visible', () => {
  const { root, mount, scroll, flush, frames } = setup();
  flush();
  scroll(1201);
  assert.equal(frames.size, 0, 'outside the preload buffer');
  scroll(1000);
  assert.equal(frames.size, 1, 'start while the boundary is still 1000 px above the viewport');
  flush();
  assert.equal(mount.dataset.historyStart, '60');
  assert.equal(root.scrollTop, 4000, 'the old rows retain their screen positions');
  assert.equal(mount.firstElementChild.textContent, 'Message 60');
  assert.equal(mount.lastElementChild.textContent, 'Message 119');
  scroll(900);
  flush();
  assert.equal(mount.dataset.historyStart, '30', 'continued scrolling loads the next page');
});

test('the preload distance scales with a taller viewport', () => {
  const { mount, scroll, flush } = setup({ viewport: 900 });
  scroll(1700);
  flush();
  assert.equal(mount.dataset.historyStart, '60', 'load before either of two 900 px screens is exhausted');
});

for (const gesture of ['wheel', 'keyboard', 'touch']) {
  test(`${gesture} requests history when approaching the buffer boundary`, () => {
    const { win, root, mount, flush, wheel } = setup();
    flush();
    root.scrollTop = 1000;
    if (gesture === 'wheel') wheel(-40);
    else if (gesture === 'keyboard') root.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'PageUp' }));
    else {
      root.dispatchEvent(new win.TouchEvent('touchstart', { touches: [{ clientY: 100 }] }));
      root.dispatchEvent(new win.TouchEvent('touchmove', { touches: [{ clientY: 140 }] }));
    }
    flush();
    assert.equal(mount.dataset.historyStart, '60');
    assert.equal(mount.children.length, 60);
  });
}

test('downward gestures and scrolling never request earlier history', () => {
  const { win, root, mount, wheel, scroll, flush } = setup({ top: 0 });
  wheel(40);
  scroll(100);
  root.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'PageDown' }));
  root.dispatchEvent(new win.TouchEvent('touchstart', { touches: [{ clientY: 140 }] }));
  root.dispatchEvent(new win.TouchEvent('touchmove', { touches: [{ clientY: 100 }] }));
  flush();
  assert.equal(mount.dataset.historyStart, '90');
});

test('short initial history fills the scroll buffer before the first gesture', () => {
  const { root, mount, scroll, flush } = setup({ rowHeight: 24 });
  assert.equal(root.scrollTop, 120, 'the initial tail has too little room for one wheel gesture');
  flush();
  assert.equal(mount.dataset.historyStart, '30', 'load only enough pages for the initial buffer');
  assert.equal(root.scrollTop, 1560);
  assert.equal(root.scrollHeight - root.scrollTop - root.clientHeight, 0, 'remain at the latest message');
  scroll(root.scrollTop - 900);
  flush();
  assert.equal(root.scrollHeight - root.scrollTop - root.clientHeight, 900,
    'the first gesture traverses its full distance without hitting a temporary top');
});

test('an initially collapsed transcript warms through invisible pages without a gesture', () => {
  const { root, mount, flush } = setup({ invisible: index => index >= 60 });
  assert.equal(root.scrollHeight, 0);
  flush();
  assert.equal(mount.dataset.historyStart, '30');
  assert.equal(root.scrollTop, 2400, 'enough readable history is ready for the first scroll');
});

test('a zero-height surface does not eagerly fill its history', () => {
  const { mount, flush } = setup({ viewport: 0, rowHeight: 1 });
  flush();
  assert.equal(mount.dataset.historyStart, '90');
});

test('pages without visible rows do not strand the reader at the history boundary', () => {
  const { root, mount, scroll, flush } = setup({ invisible: index => index >= 60 && index < 90 });
  scroll(1000);
  flush();
  assert.equal(mount.dataset.historyStart, '30', 'continue across the invisible page to fill the buffer');
  assert.equal(root.scrollTop, 4000);
});

test('turning downward stops filling the buffer after an in-flight page', () => {
  const { mount, scroll, wheel, flush } = setup({ invisible: index => index >= 60 && index < 90 });
  scroll(1000);
  wheel(40);
  flush();
  assert.equal(mount.dataset.historyStart, '60');
});

test('hidden windows pause paging and disposal cancels pending work', () => {
  const { win, mount, scroll, frames, flush, dispose } = setup();
  const stopTracking = initRenderIdleTracking();
  try {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new win.Event('visibilitychange'));
    scroll(1000);
    assert.equal(frames.size, 0);
    assert.equal(mount.dataset.historyStart, '90');
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new win.Event('visibilitychange'));
    assert.equal(frames.size, 1);
    dispose();
    flush();
    assert.equal(mount.dataset.historyStart, '90');
    scroll(0);
    assert.equal(frames.size, 0, 'disposed pagers remove their input listeners');
  } finally { stopTracking(); }
});
