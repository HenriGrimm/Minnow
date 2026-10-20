/**
 * Composer model trigger: label sync from #modelSelect.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createEmptyChatObject,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';

describe('composer model trigger', () => {
  test('syncs the selected label and keeps Pools anchored on the opening side', async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML = `
      <select id="modelSelect">
        <option value="qwen/qwen2.5-7b">Qwen 2.5 7B</option>
      </select>
      <div id="desktopComposerModelAnchor"></div>
      <span id="modelSelectTriggerText">Qwen 2.5 7B</span>
    `;

    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    (globalThis as { document: Document }).document = doc as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;

    const chat = createEmptyChatObject('qwen/qwen2.5-7b');
    setSessionStateForTests({ chats: [chat], activeId: chat.id });

    try {
      const {
        initComposerModelTriggers,
        syncComposerModelTriggers,
      } = await import('../../src/ui/composer-model-trigger.ts');

      const sel = doc.getElementById('modelSelect') as HTMLSelectElement;
      sel.value = 'qwen/qwen2.5-7b';

      initComposerModelTriggers();
      syncComposerModelTriggers();

      const label = doc.querySelector('.composer-model-trigger__label');
      assert.equal(label?.textContent, 'Qwen 2.5 7B');

      const logo = doc.querySelector('.composer-model-trigger__logo');
      assert.ok(logo);
      assert.ok(logo?.querySelector('svg'));

      const trigger = doc.querySelector('.composer-model-trigger');
      const spinner = doc.querySelector('.composer-model-trigger__spinner') as HTMLElement | null;
      assert.ok(spinner);
      assert.notEqual(spinner?.dataset.loadState, 'loading');
      assert.equal(trigger?.getAttribute('aria-busy'), null);

      // Pools can grow beyond the room above the composer after its async load.
      // It must scroll on the opening side rather than jump below the trigger.
      const panel = doc.querySelector('.composer-model-menu') as unknown as HTMLElement;
      Object.defineProperty(trigger, 'getBoundingClientRect', { configurable: true,
        value: () => ({ top: 600, bottom: 630, left: 500, right: 620, width: 120, height: 30 }) });
      let panelHeight = 450;
      Object.defineProperty(panel, 'offsetHeight', { configurable: true, get: () => panelHeight });
      (trigger as unknown as HTMLButtonElement).click();
      assert.equal(panel.dataset.placement, 'above');
      const bottom = panel.style.bottom;
      assert.equal(panel.style.maxHeight, '588px');
      panelHeight = 900;
      panel.querySelector<HTMLButtonElement>('.model-pool-tab')!.click();
      assert.equal(panel.style.top, 'auto');
      assert.equal(panel.style.bottom, bottom);
      assert.equal(panel.style.maxHeight, '588px');
      // A later layout pass (loaded content or resizing) keeps the same anchor.
      win.dispatchEvent(new win.Event('resize'));
      assert.equal(panel.dataset.placement, 'above');
      assert.equal(panel.style.bottom, bottom);
      Object.defineProperty(win, 'innerWidth', { configurable: true, value: 390 });
      Object.defineProperty(panel, 'offsetWidth', { configurable: true, value: 374 });
      win.dispatchEvent(new win.Event('resize'));
      assert.equal(panel.style.left, '8px');
      assert.equal(panel.style.bottom, bottom);
      const { closeComposerModelMenu } = await import('../../src/ui/composer-model-trigger.ts');
      closeComposerModelMenu();
      Object.defineProperty(trigger, 'getBoundingClientRect', { configurable: true,
        value: () => ({ top: 30, bottom: 60, left: 200, right: 320, width: 120, height: 30 }) });
      (trigger as unknown as HTMLButtonElement).click();
      assert.equal(panel.dataset.placement, 'below', 'reopening chooses a fresh side');
      assert.equal(panel.style.top, '64px');
      assert.equal(panel.style.bottom, 'auto');
      closeComposerModelMenu();

      sel.innerHTML = '<option value="">Loading models…</option>';
      syncComposerModelTriggers();
      assert.equal(spinner?.dataset.loadState, 'loading');
      assert.equal(trigger?.getAttribute('aria-busy'), 'true');
    } finally {
      setSessionStateForTests(null);
      (globalThis as { document: Document }).document = prevDocument;
      (globalThis as { window: Window }).window = prevWindow;
    }
  });

  test('mounts the Code chip after compact parks Tools out of the trail', async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML = `
      <select id="modelSelect">
        <option value="qwen/qwen2.5-7b">Qwen 2.5 7B</option>
      </select>
      <span id="modelSelectTriggerText">Qwen 2.5 7B</span>
      <div class="composer-controls" id="composerControls">
        <div class="composer-controls__trail">
          <div id="codeComposerModelAnchor" class="composer-model-trigger-anchor"></div>
        </div>
      </div>
      <div id="composerOverflowToolsBody"></div>
    `;

    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    (globalThis as { document: Document }).document = doc as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;

    const chat = createEmptyChatObject('qwen/qwen2.5-7b');
    setSessionStateForTests({ chats: [chat], activeId: chat.id });

    try {
      const { initComposerModelTriggers } = await import('../../src/ui/composer-model-trigger.ts');
      initComposerModelTriggers();

      const wrap = doc.querySelector('#codeComposerModelAnchor .composer-model-trigger-wrap');
      assert.ok(wrap, 'Code composer model trigger should mount without Tools in the trail');
      assert.equal(
        doc.querySelector('#codeComposerModelAnchor .composer-model-trigger__label')?.textContent,
        'Qwen 2.5 7B',
      );
    } finally {
      setSessionStateForTests(null);
      (globalThis as { document: Document }).document = prevDocument;
      (globalThis as { window: Window }).window = prevWindow;
    }
  });
});
