import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const {
  autoResize,
  bindComposerAutoResize,
  setComposerFieldSizingSupportedForTests,
} = await import('../../src/ui/composer-auto-resize.ts');

function setupTextarea() {
  const window = new Window({ innerHeight: 800 });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;

  const el = document.createElement('textarea');
  el.id = 'msgInput';
  el.style.boxSizing = 'border-box';
  el.style.padding = '11px 14px';
  el.style.lineHeight = '1.55';
  el.style.fontSize = '14px';
  el.style.width = '400px';
  document.body.appendChild(el);
  return el;
}

describe('autoResize', () => {
  test('field-sizing restores scrolling after composer clear and preserves the offset on reclamp', () => {
    setComposerFieldSizingSupportedForTests(true);
    const el = setupTextarea();
    el.style.overflowY = 'hidden';
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 900 });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 320 });
    el.scrollTop = 140;
    autoResize(el);
    assert.equal(el.style.overflowY, 'auto');
    assert.equal(el.style.getPropertyValue('field-sizing'), 'fixed');
    assert.equal(el.scrollTop, 140);
    autoResize(el);
    assert.equal(el.scrollTop, 140);
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 44 });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 44 });
    autoResize(el);
    assert.equal(el.style.overflowY, 'hidden');
    assert.equal(el.style.height, '');
  });

  test('keyboard opening reclamps a long draft, but pinch zoom does not', () => {
    setComposerFieldSizingSupportedForTests(false);
    const el = setupTextarea();
    const viewport = new window.EventTarget();
    viewport.height = 400;
    viewport.scale = 1;
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 900 });
    const dispose = bindComposerAutoResize(el);
    assert.equal(el.style.height, '44px');
    viewport.height = 300;
    viewport.dispatchEvent(new window.Event('resize'));
    assert.equal(el.style.height, '44px');
    viewport.scale = 2;
    viewport.dispatchEvent(new window.Event('resize'));
    assert.equal(el.style.height, '320px');
    dispose();
    viewport.height = 200;
    viewport.scale = 1;
    viewport.dispatchEvent(new window.Event('resize'));
    assert.equal(el.style.height, '320px');
  });

  afterEach(() => {
    setComposerFieldSizingSupportedForTests(null);
  });

  test('short content stays hidden overflow under 40vh cap', () => {
    setComposerFieldSizingSupportedForTests(false);
    const el = setupTextarea();
    el.value = 'Hello';
    autoResize(el);

    assert.equal(el.style.overflowY, 'hidden');
    assert.ok(parseInt(el.style.height, 10) >= 44);
    assert.ok(parseInt(el.style.height, 10) <= 320);
  });

  test('cleared value resets to minimum height', () => {
    setComposerFieldSizingSupportedForTests(false);
    const el = setupTextarea();
    el.value = 'Line one\nLine two\nLine three';
    autoResize(el);
    el.value = '';
    autoResize(el);

    assert.equal(el.style.overflowY, 'hidden');
    assert.equal(el.style.height, '44px');
  });

  test('single-line typing does not collapse height to auto', () => {
    setComposerFieldSizingSupportedForTests(false);
    const el = setupTextarea();
    el.value = 'Hello';
    autoResize(el);
    const firstHeight = el.style.height;
    el.value = 'Hello world';
    autoResize(el);

    assert.equal(el.style.height, firstHeight);
    assert.notEqual(el.style.height, 'auto');
  });

  test('field-sizing path clears leftover inline height', () => {
    setComposerFieldSizingSupportedForTests(true);
    const el = setupTextarea();
    el.style.height = '120px';
    el.value = 'Hello';
    autoResize(el);

    assert.equal(el.style.height, '');
  });

  test('JS fallback honors a taller CSS min-height (Super Plan floor)', () => {
    setComposerFieldSizingSupportedForTests(false);
    const el = setupTextarea();
    el.style.minHeight = '96px';
    el.value = '';
    autoResize(el);

    assert.equal(el.style.height, '96px');
    assert.equal(el.style.overflowY, 'hidden');
  });

  test('bindComposerAutoResize is idempotent and skips JS when field-sizing works', () => {
    setComposerFieldSizingSupportedForTests(true);
    const el = setupTextarea();
    const unbind = bindComposerAutoResize(el);
    bindComposerAutoResize(el);

    assert.equal(el.dataset.composerAutoResizeWired, '1');
    assert.equal(el.style.height, '');
    unbind();
    assert.equal(el.dataset.composerAutoResizeWired, undefined);
  });

  test('panel width changes clamp overflowing drafts and release the clamp when widened', async () => {
    setComposerFieldSizingSupportedForTests(true);
    const el = setupTextarea();
    el.style.maxHeight = '320px';
    el.value = 'A draft that wraps onto more lines in a narrow panel.';
    let width = 400;
    Object.defineProperty(el, 'clientWidth', { get: () => width });
    Object.defineProperty(el, 'scrollHeight', { get: () => width < 300 ? 500 : 100 });

    const originalObserver = globalThis.ResizeObserver;
    const observers = [];
    globalThis.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        observers.push(this);
      }
      observe(target) { this.target = target; }
      disconnect() { this.disconnected = true; }
    };
    try {
      const unbind = bindComposerAutoResize(el);
      bindComposerAutoResize(el);
      assert.equal(observers.length, 1);
      assert.equal(observers[0].target, el);
      assert.equal(el.style.height, '');

      width = 200;
      observers[0].callback();
      await new Promise(resolve => window.requestAnimationFrame(resolve));
      assert.equal(el.style.height, '320px');
      assert.equal(el.style.getPropertyValue('field-sizing'), 'fixed');

      width = 400;
      observers[0].callback();
      await new Promise(resolve => window.requestAnimationFrame(resolve));
      assert.equal(el.style.height, '');
      assert.equal(el.style.getPropertyValue('field-sizing'), '');

      unbind();
      assert.equal(observers[0].disconnected, true);
    } finally {
      globalThis.ResizeObserver = originalObserver;
    }
  });
});
