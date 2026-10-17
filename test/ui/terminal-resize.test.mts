import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { bindTerminalResizeHandle } from '../../src/ui/terminal-resize.ts';

for (const endEvent of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  test(`terminal resize captures input and stops on ${endEvent}`, () => {
    const window = new Window();
    const handle = window.document.createElement('div');
    const panel = window.document.createElement('section');
    let captured: number | undefined;
    handle.setPointerCapture = (id) => { captured = id; };
    panel.getBoundingClientRect = () => ({ height: 400 }) as DOMRect;
    const heights: number[] = [];
    bindTerminalResizeHandle(handle as unknown as HTMLElement, panel as unknown as HTMLElement, (h) => heights.push(h));
    const pointer = (type: string, y: number, button = 0) => handle.dispatchEvent(
      new window.PointerEvent(type, { clientY: y, button, pointerId: 7, cancelable: true }),
    );
    pointer('pointerdown', 500, 2);
    pointer('pointermove', 450);
    assert.deepEqual(heights, []);
    pointer('pointerdown', 500);
    assert.equal(captured, 7);
    assert.equal(handle.classList.contains('dragging'), true);
    pointer('pointermove', 450);
    pointer('pointermove', 550);
    assert.deepEqual(heights, [450, 350]);
    pointer(endEvent, 550);
    assert.equal(handle.classList.contains('dragging'), false);
    pointer('pointermove', 600);
    assert.deepEqual(heights, [450, 350]);
    window.close();
  });
}
