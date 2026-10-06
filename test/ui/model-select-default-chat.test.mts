/**
 * Global default model (#modelSelect / menubar) vs per-chat composer binding.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createEmptyChatObject,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';

describe('onModelSelectChange', () => {
  test('updates ephemeral empty active chat to new default', async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const doc = win.document;
    const grokKey = encodeModelSelectKey('opencode', 'grok-4.5');
    const deepseekKey = encodeModelSelectKey('opencode', 'deepseek-v4-flash');
    doc.body.innerHTML = `
      <select id="modelSelect">
        <option value="${grokKey}">Grok 4.5 — OpenCode Go</option>
        <option value="${deepseekKey}">Deepseek v4 flash — OpenCode Go</option>
      </select>
      <div id="codeComposerModelAnchor"></div>
      <span id="modelSelectTriggerText"></span>
    `;

    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    (globalThis as { document: Document }).document = doc as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;

    const chat = createEmptyChatObject('grok-4.5');
    chat.providerId = 'opencode';
    chat.modelId = 'grok-4.5';
    setSessionStateForTests({ chats: [chat], activeId: chat.id });

    try {
      const sel = doc.getElementById('modelSelect') as HTMLSelectElement;
      sel.value = deepseekKey;

      const { onModelSelectChange } = await import('../../src/ui/sidebar.ts');
      onModelSelectChange();

      assert.equal(chat.modelId, 'deepseek-v4-flash');
      assert.equal(chat.providerId, 'opencode');

      const {
        initComposerModelTriggers,
        syncComposerModelTriggers,
      } = await import('../../src/ui/composer-model-trigger.ts');
      const codeTrail = doc.createElement('div');
      codeTrail.className = 'composer-controls__trail';
      const toolsAnchor = doc.createElement('div');
      toolsAnchor.className = 'composer-tools-anchor';
      codeTrail.appendChild(toolsAnchor);
      doc.body.appendChild(codeTrail);
      initComposerModelTriggers();
      syncComposerModelTriggers();

      const label = doc.querySelector('.composer-model-trigger__label');
      // The Code footer names the model; the provider moves to the tooltip.
      assert.equal(label?.textContent, 'Deepseek v4 flash');
      assert.equal((label as HTMLElement | null)?.title, 'Deepseek v4 flash — OpenCode Go');
    } finally {
      setSessionStateForTests(null);
      (globalThis as { document: Document }).document = prevDocument;
      (globalThis as { window: Window }).window = prevWindow;
    }
  });

  test('does not change active chat that already has messages', async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const doc = win.document;
    const grokKey = encodeModelSelectKey('opencode', 'grok-4.5');
    const deepseekKey = encodeModelSelectKey('opencode', 'deepseek-v4-flash');
    doc.body.innerHTML = `
      <select id="modelSelect">
        <option value="${grokKey}">Grok 4.5 — OpenCode Go</option>
        <option value="${deepseekKey}">Deepseek v4 flash — OpenCode Go</option>
      </select>
      <span id="modelSelectTriggerText"></span>
    `;

    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    (globalThis as { document: Document }).document = doc as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;

    const chat = createEmptyChatObject('grok-4.5');
    chat.providerId = 'opencode';
    chat.modelId = 'grok-4.5';
    chat.history.push({ role: 'user', content: 'hello' });
    setSessionStateForTests({ chats: [chat], activeId: chat.id });

    try {
      const sel = doc.getElementById('modelSelect') as HTMLSelectElement;
      sel.value = deepseekKey;

      const { onModelSelectChange } = await import('../../src/ui/sidebar.ts');
      onModelSelectChange();

      assert.equal(chat.modelId, 'grok-4.5');
      assert.equal(chat.providerId, 'opencode');
    } finally {
      setSessionStateForTests(null);
      (globalThis as { document: Document }).document = prevDocument;
      (globalThis as { window: Window }).window = prevWindow;
    }
  });
});
