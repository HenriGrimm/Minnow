import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';
import { getFilePanelState, patchFilePanelState, resetFilePanelStateForTests } from '../../src/state/file-panel.ts';
import { initAppSidebarResizers } from '../../src/ui/sidebar-resize.ts';

test('file sidebar batches 200 moves into one paint and commits the final width on blur', async () => {
  const win = new Window();
  installHappyDomGlobals(win);
  try {
    document.body.innerHTML = '<div id="appBody"><div id="chatSidebarResizer"></div><div id="fileSidebarResizer"></div></div>';
    patchFilePanelState({ fileSidebarCollapsed: false, fileSidebarWidth: 350 });
    const body = document.getElementById('appBody')!;
    const handle = document.getElementById('fileSidebarResizer')!;
    handle.setPointerCapture = () => {};
    let reads = 0;
    body.getBoundingClientRect = () => {
      reads++;
      return { left: 0, right: 1000, width: 1000 } as DOMRect;
    };
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    win.requestAnimationFrame = (cb) => { frames.set(++nextFrame, cb); return nextFrame; };
    win.cancelAnimationFrame = (id) => { frames.delete(id); };
    initAppSidebarResizers();
    handle.dispatchEvent(new win.PointerEvent('pointerdown', { pointerId: 1 }));
    for (let x = 0; x < 200; x++) win.dispatchEvent(new win.PointerEvent('pointermove', { clientX: x }));
    assert.equal(reads, 1, 'geometry is captured at drag start, not on every move');
    assert.equal(frames.size, 1);
    assert.equal(getFilePanelState().fileSidebarWidth, 350);
    frames.values().next().value!(0);
    assert.equal(body.style.getPropertyValue('--file-sidebar-w'), '550px');
    assert.equal(getFilePanelState().fileSidebarWidth, 350, 'live paint does not persist');
    win.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 620 }));
    win.dispatchEvent(new win.Event('blur'));
    assert.equal(getFilePanelState().fileSidebarWidth, 380, 'blur flushes the final queued position');
    assert.equal(body.style.getPropertyValue('--file-sidebar-w'), '380px');
    assert.equal(frames.size, 0);
  } finally {
    resetFilePanelStateForTests();
    await teardownHappyDomAsync(win);
  }
});
