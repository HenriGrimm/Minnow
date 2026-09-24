import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Window } from 'happy-dom';
import { initRenderIdleTracking, isRenderIdle, subscribeRenderIdle } from '../../src/boot/render-idle.ts';

type Globals = typeof globalThis & { document: Document; window: Window };

/** Mount a happy-dom window as the ambient globals the module reads. */
function mountWindow(): { win: Window; restore: () => void } {
  const win = new Window();
  const g = globalThis as Globals;
  const prevDoc = g.document;
  const prevWin = g.window;
  g.document = win.document as unknown as Document;
  g.window = win;
  return {
    win,
    restore: () => {
      g.document = prevDoc;
      g.window = prevWin;
      win.close();
    },
  };
}

/** happy-dom has no visibility control — drive `visibilityState` directly. */
function setVisibility(win: Window, state: 'visible' | 'hidden'): void {
  Object.defineProperty(win.document, 'visibilityState', {
    value: state,
    configurable: true,
  });
  win.document.dispatchEvent(new win.Event('visibilitychange'));
}

describe('render idle tracking', () => {
  let teardown: (() => void) | null = null;
  let restore: (() => void) | null = null;

  afterEach(() => {
    teardown?.();
    teardown = null;
    restore?.();
    restore = null;
  });

  it('parks animation when the document goes hidden and resumes on return', () => {
    const mounted = mountWindow();
    restore = mounted.restore;

    teardown = initRenderIdleTracking();
    assert.equal(isRenderIdle(), false);

    setVisibility(mounted.win, 'hidden');
    assert.equal(isRenderIdle(), true);
    assert.equal(mounted.win.document.documentElement.getAttribute('data-mn-render'), 'idle');

    setVisibility(mounted.win, 'visible');
    assert.equal(isRenderIdle(), false);
    assert.equal(mounted.win.document.documentElement.hasAttribute('data-mn-render'), false);
  });

  it('parks on a main-process hide even while the document still reads visible', () => {
    const mounted = mountWindow();
    restore = mounted.restore;

    /** @type {(visible: boolean) => void} */
    let push: ((visible: boolean) => void) | null = null;
    (mounted.win as unknown as { minnow: unknown }).minnow = {
      window: {
        onVisibilityChanged: (cb: (visible: boolean) => void) => {
          push = cb;
          return () => {
            push = null;
          };
        },
      },
    };
    (globalThis as Globals).window = mounted.win;

    teardown = initRenderIdleTracking();
    assert.equal(isRenderIdle(), false);
    assert.ok(push, 'main-process visibility push should be subscribed');

    // Tray-hide: the document can still report "visible" with background throttling off.
    push!(false);
    assert.equal(isRenderIdle(), true);

    setVisibility(mounted.win, 'visible');
    assert.equal(isRenderIdle(), true, 'document events must not override a native hide');

    push!(true);
    assert.equal(isRenderIdle(), false);
  });

  it('notifies view subscribers once per transition and supports cleanup', () => {
    const mounted = mountWindow();
    restore = mounted.restore;
    teardown = initRenderIdleTracking();
    const transitions: boolean[] = [];
    const unsubscribe = subscribeRenderIdle((idle) => transitions.push(idle));
    setVisibility(mounted.win, 'hidden');
    setVisibility(mounted.win, 'hidden');
    setVisibility(mounted.win, 'visible');
    unsubscribe();
    setVisibility(mounted.win, 'hidden');
    assert.deepEqual(transitions, [true, false]);
  });

  it('is idempotent and restores a clean root on teardown', () => {
    const mounted = mountWindow();
    restore = mounted.restore;

    const stop = initRenderIdleTracking();
    // A second call must not double-subscribe or clobber the first teardown.
    const noop = initRenderIdleTracking();
    setVisibility(mounted.win, 'hidden');
    assert.equal(isRenderIdle(), true);

    noop();
    assert.equal(isRenderIdle(), true, 'second handle is inert');

    stop();
    assert.equal(mounted.win.document.documentElement.hasAttribute('data-mn-render'), false);
    teardown = null;
  });
});
