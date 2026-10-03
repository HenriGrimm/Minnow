import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createViewport } from '../../src/ui/spatial-viewport.ts';
import { spatialTestDom } from './spatial-test-dom.ts';

test('independent viewport prefixes, fit, reveal, keyboard pan/zoom, and teardown', () => {
  const dom = spatialTestDom();
  try {
    const canvas = document.createElement('div');
    const scene = document.createElement('div');
    canvas.append(scene);
    canvas.getBoundingClientRect = () => ({ width: 800, height: 600, x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, toJSON() {} });
    const api = createViewport(canvas, scene, null, { prefix: 'test-map' });
    api.setContent(1600, 1200);
    api.fit();
    assert.equal(api.getState().k, 0.5);
    assert.equal(canvas.style.getPropertyValue('--test-map-zoom'), '0.5');
    assert.equal(canvas.style.getPropertyValue('--code-map-zoom'), '');
    const key = (key: string) => canvas.dispatchEvent(new dom.browser.KeyboardEvent('keydown', { key, bubbles: true }));
    key('+');
    assert.equal(api.getState().k, 0.6);
    key('-');
    assert.equal(api.getState().k, 0.5);
    const x = api.getState().x;
    key('ArrowRight');
    assert.equal(api.getState().x, x - 64);
    api.reveal({ x: 1400, y: 1200, w: 100, h: 100 });
    assert.ok(api.getState().y < 0);
    key('0');
    assert.equal(api.getState().k, 0.5);
    api.reset();
    assert.deepEqual(api.getState(), { x: 24, y: 24, k: 1 });
    api.destroy();
    const state = api.getState();
    key('+');
    assert.deepEqual(api.getState(), state);
    assert.equal(dom.disconnected(), 1);
  } finally { dom.destroy(); }
});

test('drag suppresses the ending click and releases capture on destroy', () => {
  const dom = spatialTestDom();
  try {
    const canvas = document.createElement('div');
    const scene = document.createElement('div');
    let captured = false;
    canvas.setPointerCapture = () => { captured = true; };
    canvas.hasPointerCapture = () => captured;
    canvas.releasePointerCapture = () => { captured = false; };
    const api = createViewport(canvas, scene, null);
    const pointer = (type: string, x: number) => canvas.dispatchEvent(new dom.browser.PointerEvent(type, { pointerId: 1, button: 0, clientX: x, bubbles: true }));
    pointer('pointerdown', 0);
    pointer('pointermove', 50);
    assert.equal(captured, true);
    pointer('pointerup', 50);
    assert.equal(api.consumeDrag(), true);
    assert.equal(captured, false);
    pointer('pointerdown', 0);
    pointer('pointermove', 50);
    api.destroy();
    assert.equal(captured, false);
  } finally { dom.destroy(); }
});

test('horizontal navigation stays vertically centered, bounds empty space and scrolls without zooming', () => {
  const dom = spatialTestDom();
  try {
    const canvas = document.createElement('div');
    const scene = document.createElement('div');
    let height = 600;
    canvas.getBoundingClientRect = () => ({ width: 800, height, x: 0, y: 0, top: 0, left: 0, right: 800, bottom: height, toJSON() {} });
    let captured = false;
    canvas.setPointerCapture = () => { captured = true; };
    canvas.hasPointerCapture = () => captured;
    canvas.releasePointerCapture = () => { captured = false; };
    const api = createViewport(canvas, scene, null, { horizontal: true });
    api.setContent(2000, 208);
    api.reset();
    assert.equal(api.getState().y, (height - 208) / 2);
    canvas.dispatchEvent(new dom.browser.WheelEvent('wheel', { deltaY: 100, deltaMode: 0 }));
    assert.equal(api.getState().k, 1);
    assert.equal(api.getState().x, -76);
    canvas.dispatchEvent(new dom.browser.PointerEvent('pointerdown', { pointerId: 1, button: 0, clientX: 0, clientY: 0 }));
    canvas.dispatchEvent(new dom.browser.PointerEvent('pointermove', { pointerId: 1, clientX: -50, clientY: 150 }));
    assert.equal(api.getState().x, -126);
    assert.equal(api.getState().y, 196, 'vertical drag cannot move the map');
    api.panBy(5000, 5000);
    assert.equal(api.getState().x, 32, 'panning cannot reveal an unbounded empty canvas');
    api.zoomBy(0.5);
    assert.equal(api.getState().y, 248);
    height = 400;
    api.setContent(2000, 208);
    assert.equal(api.getState().y, 148, 'opening review centers the map in its shorter viewport');
    api.fit();
    assert.equal(api.getState().x, 0, 'a fitted timeline stays centered horizontally as well');
    api.destroy();
  } finally { dom.destroy(); }
});

test('horizontal centering uses the visible rows without shrinking for distant branch lanes', () => {
  const dom = spatialTestDom();
  try {
    const canvas = document.createElement('div');
    const scene = document.createElement('div');
    canvas.getBoundingClientRect = () => ({ width: 800, height: 300, x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 300, toJSON() {} });
    const api = createViewport(canvas, scene, null, { horizontal: true,
      horizontalRange: () => ({ top: 24, bottom: 160 }),
    });
    api.setContent(2000, 10000);
    api.reset();
    assert.equal(api.getState().k, 1, 'off-screen branches do not shrink the viewed commits');
    assert.equal(api.getState().y + 92, 150, 'the viewed branch rows are centered');
    api.zoomBy(0.5);
    assert.equal(api.getState().y + 92 * 0.5, 150);
    api.destroy();
  } finally { dom.destroy(); }
});
