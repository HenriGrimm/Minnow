import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  TABLET_MQ,
  initMobileLayout,
  resetMobileLayoutForTests,
} from '../../src/ui/mobile-layout.ts';

describe('mobile layout', () => {
  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const g = globalThis as typeof globalThis & {
      window: Window;
      document: Document;
    };
    g.window = win as unknown as Window & typeof globalThis.window;
    g.document = win.document;
    resetMobileLayoutForTests();
  });

  afterEach(() => {
    resetMobileLayoutForTests();
  });

  test('TABLET_MQ requires coarse pointer so desktop web tabs are not tablet layout', () => {
    assert.match(TABLET_MQ, /pointer:\s*coarse/);
  });

  test('visual viewport follows the keyboard and preserves layout during pinch zoom', () => {
    const viewport = { height: 400, offsetTop: 220, scale: 1, addEventListener() {} };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    initMobileLayout();
    assert.equal(document.documentElement.style.getPropertyValue('--mn-viewport-height'), '400px');
    assert.equal(document.documentElement.style.getPropertyValue('--mn-viewport-offset-top'), '220px');
    viewport.height = 200;
    viewport.offsetTop = 300;
    viewport.scale = 2;
    window.dispatchEvent(new window.Event('resize'));
    assert.equal(document.documentElement.style.getPropertyValue('--mn-viewport-height'), '400px');
    assert.equal(document.documentElement.style.getPropertyValue('--mn-viewport-offset-top'), '220px');
    viewport.height = 800;
    viewport.offsetTop = 0;
    viewport.scale = 1;
    window.dispatchEvent(new window.Event('resize'));
    assert.equal(document.documentElement.style.getPropertyValue('--mn-viewport-height'), '800px');
    assert.equal(document.documentElement.style.getPropertyValue('--mn-viewport-offset-top'), '0px');
  });

  test('follows iOS keyboard panning even when the visible height does not change', () => {
    const viewport = Object.assign(new window.EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    initMobileLayout();

    viewport.height = 340;
    viewport.dispatchEvent(new window.Event('resize'));
    assert.equal(document.documentElement.style.getPropertyValue('--mn-viewport-height'), '340px');

    viewport.offsetTop = 400;
    viewport.dispatchEvent(new window.Event('scroll'));
    assert.equal(document.documentElement.style.getPropertyValue('--mn-viewport-height'), '340px');
    assert.equal(document.documentElement.style.getPropertyValue('--mn-viewport-offset-top'), '400px');

    viewport.scale = 2;
    viewport.offsetTop = 500;
    viewport.dispatchEvent(new window.Event('scroll'));
    assert.equal(document.documentElement.style.getPropertyValue('--mn-viewport-offset-top'), '400px');

    viewport.scale = 1;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new window.Event('scroll'));
    assert.equal(document.documentElement.style.getPropertyValue('--mn-viewport-offset-top'), '0px');
  });

  test('does not stamp mn-tablet for mid-width fine pointer', () => {
    window.matchMedia = ((query: string) => {
      const matches =
        query === TABLET_MQ
          ? false
          : query.includes('max-width: 640px')
            ? false
            : query === '(pointer: coarse)'
              ? false
              : false;
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      };
    }) as typeof window.matchMedia;

    initMobileLayout();

    assert.equal(document.documentElement.classList.contains('mn-tablet'), false);
  });
});
