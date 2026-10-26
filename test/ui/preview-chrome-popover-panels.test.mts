/**
 * MIN-457: overlays that must hide the Electron preview guest while open.
 */

import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import {
  createEmptyChatObject,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { PREVIEW_OCCLUDER_CLASS } from '../../src/ui/preview-occlusion.ts';

function hasMarkedOverlay(): boolean {
  return document.getElementsByClassName(PREVIEW_OCCLUDER_CLASS).length > 0;
}

describe('preview chrome popover panels (MIN-457)', () => {
  let win: import('happy-dom').Window;
  const prevDocument = globalThis.document;
  const prevWindow = globalThis.window;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  beforeEach(async () => {
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as typeof requestAnimationFrame;

    const { Window } = await import('happy-dom');
    win = new Window();
    (globalThis as { document: Document }).document = win.document as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: win.localStorage });
  });

  afterEach(async () => {
    setSessionStateForTests(null);
    try {
      const { setAgentActivityPanelOpen } = await import('../../src/ui/agent-activity-panel.ts');
      setAgentActivityPanelOpen(false);
    } catch {
      /* ignore */
    }
    try {
      const { closeModelSelectMenu } = await import('../../src/ui/model-select-picker.ts');
      closeModelSelectMenu();
    } catch {
      /* ignore */
    }
    try {
      const { closeComposerModelMenu } = await import('../../src/ui/composer-model-trigger.ts');
      closeComposerModelMenu();
    } catch {
      /* ignore */
    }
    globalThis.requestAnimationFrame = prevRaf;
    if (prevStorage) Object.defineProperty(globalThis, 'localStorage', prevStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    (globalThis as { document: Document }).document = prevDocument;
    (globalThis as { window: Window }).window = prevWindow;
  });

  test('mounted agent activity panel is marked only while open', async () => {
    const { initAgentActivityMenubar, setAgentActivityPanelOpen } = await import('../../src/ui/agent-activity-panel.ts');
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    const dispose = initAgentActivityMenubar(trigger);
    try {
      assert.equal(hasMarkedOverlay(), false);
      setAgentActivityPanelOpen(true);
      assert.equal(document.getElementById('activityDropdown')?.dataset.occluderKind, 'panel');
      assert.equal(hasMarkedOverlay(), true);
      setAgentActivityPanelOpen(false);
      assert.equal(hasMarkedOverlay(), false);
    } finally {
      dispose();
    }
  });

  test('command palettes and nested context menus retain independent overlay markers', async () => {
    const { createCommandPalette } = await import('../../src/ui/command-palette.ts');
    const { openContextMenu, closeContextMenu } = await import('../../src/ui/context-menu.ts');
    const palette = createCommandPalette({ host: document.body, getCommands: () => [], label: 'Search' });
    palette.open();
    palette.open();
    assert.equal(hasMarkedOverlay(), true);
    const menu = openContextMenu({ items: [{ kind: 'submenu', id: 'sub', label: 'More', items: [{ id: 'child', label: 'Child', onSelect: () => {} }] }] });
    menu.root.querySelector('button')?.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    palette.destroy();
    assert.equal(hasMarkedOverlay(), true);
    closeContextMenu();
    closeContextMenu();
    assert.equal(hasMarkedOverlay(), false);
  });

  test('top-bar model select is marked while menu is open', async () => {
    win.document.body.innerHTML = `
      <div class="model-select-inner">
        <select id="modelSelect"><option value="p/m">m</option></select>
        <button type="button" id="modelSelectTrigger"><span id="modelSelectTriggerText"></span></button>
        <ul id="modelSelectMenu" class="model-select-menu hidden"></ul>
      </div>
    `;
    const { initModelSelectPicker, closeModelSelectMenu } = await import(
      '../../src/ui/model-select-picker.ts'
    );

    initModelSelectPicker();
    const trigger = win.document.getElementById('modelSelectTrigger') as HTMLButtonElement;
    assert.ok(trigger);

    assert.equal(hasMarkedOverlay(), false);
    trigger.click();
    assert.equal(hasMarkedOverlay(), true);
    closeModelSelectMenu();
    assert.equal(hasMarkedOverlay(), false);
  });

  test('issue capture popover is marked while open', async () => {
    const { emptyCapturePayload } = await import('../../src/issues/capture-payload.ts');
    const { openIssueCapture, closeIssueCapture, resetIssueCaptureForTests } = await import(
      '../../src/ui/issue-capture-popover.ts'
    );

    try {
      assert.equal(hasMarkedOverlay(), false);
      openIssueCapture({ payload: emptyCapturePayload() });
      assert.equal(hasMarkedOverlay(), true);
      closeIssueCapture({ restoreFocus: false, clearDraft: true });
      assert.equal(hasMarkedOverlay(), false);
    } finally {
      resetIssueCaptureForTests();
    }
  });

  test('minimal quick capture shows only its input and two create actions', async () => {
    const { emptyCapturePayload } = await import('../../src/issues/capture-payload.ts');
    const { openIssueCapture, closeIssueCapture, resetIssueCaptureForTests } = await import(
      '../../src/ui/issue-capture-popover.ts'
    );

    try {
      openIssueCapture({ payload: emptyCapturePayload(), minimal: true });
      const popover = win.document.querySelector('.mn-capture--minimal');
      assert.ok(popover);
      assert.deepEqual(
        [...popover.querySelectorAll('input, button')].map((element) =>
          element.tagName === 'INPUT' ? element.getAttribute('aria-label') : element.textContent,
        ),
        ['Issue title', 'Create Issue', 'Expand and Create'],
      );
    } finally {
      closeIssueCapture({ restoreFocus: false, clearDraft: true });
      resetIssueCaptureForTests();
    }
  });
  test('composer model menu is marked while open', async () => {
    win.document.body.innerHTML = `
      <select id="modelSelect"><option value="qwen/qwen2.5-7b">Qwen 2.5 7B</option></select>
      <div id="codeComposerModelAnchor"></div>
    `;
    const chat = createEmptyChatObject('qwen/qwen2.5-7b');
    setSessionStateForTests({ chats: [chat], activeId: chat.id });

    const { mountComposerModelTrigger, closeComposerModelMenu } = await import(
      '../../src/ui/composer-model-trigger.ts'
    );

    mountComposerModelTrigger(win.document.getElementById('codeComposerModelAnchor')!, 'code');
    const trigger = win.document.querySelector('.composer-model-trigger') as HTMLButtonElement;
    assert.ok(trigger);

    assert.equal(hasMarkedOverlay(), false);
    trigger.click();
    assert.equal(hasMarkedOverlay(), true);
    closeComposerModelMenu();
    assert.equal(hasMarkedOverlay(), false);
  });

  test('each toast is marked as a notification, not its click-through stack', async () => {
    const { showToast } = await import('../../src/ui/toast.ts');
    showToast('Preview occlusion marker', 'error');
    const toast = document.querySelector<HTMLElement>('.mn-toast');
    assert.ok(toast?.classList.contains(PREVIEW_OCCLUDER_CLASS));
    assert.equal(toast.dataset.occluderKind, 'notification');
    assert.equal(document.querySelector('.mn-toast-stack')?.classList.contains(PREVIEW_OCCLUDER_CLASS), false);
    toast.querySelector<HTMLButtonElement>('.mn-toast__dismiss')?.click();
    assert.equal(hasMarkedOverlay(), false);
  });
});
