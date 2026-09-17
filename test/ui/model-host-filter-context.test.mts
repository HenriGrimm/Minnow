/**
 * Host filter bar resolves load/unload against per-chat model in composer menus.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';

describe('model host filter load/unload context', () => {
  test('composer resolver uses active chat model, not global default', async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const doc = win.document;

    const cloudKey = encodeModelSelectKey('cloud', 'opencode');
    const localKey = encodeModelSelectKey('lmstudio', 'qwen');

    doc.body.innerHTML = `
      <select id="modelSelect">
        <option value="${cloudKey}">OpenCode Go</option>
        <option value="${localKey}">Qwen 2.5 7B — LM Studio</option>
      </select>
      <div id="panel"></div>
    `;

    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    (globalThis as { document: Document }).document = doc as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;

    try {
      const sel = doc.getElementById('modelSelect') as HTMLSelectElement;
      sel.value = cloudKey;

      const { mountModelHostFilterBar } = await import(
        '../../src/ui/model-select-picker.ts'
      );
      const { resolveModelHostFilterLoadUnloadValue } = await import(
        '../../src/ui/model-host-filter-context.ts'
      );

      const panel = doc.getElementById('panel')!;
      mountModelHostFilterBar(panel, {
        onFilterChange: () => {},
        resolveLoadUnloadValue: () => localKey,
      });

      const bar = panel.querySelector('.model-select-host-filter') as HTMLDivElement;
      assert.ok(bar);

      const resolved = resolveModelHostFilterLoadUnloadValue(bar);
      assert.equal(resolved, localKey);
      assert.notEqual(resolved, cloudKey);
    } finally {
      (globalThis as { document: Document }).document = prevDocument;
      (globalThis as { window: Window }).window = prevWindow;
    }
  });

  test('menu action row targets the open composer model, not the global default', async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const doc = win.document;

    const cloudKey = encodeModelSelectKey('cloud', 'opencode');
    const localKey = encodeModelSelectKey('lmstudio', 'qwen');

    doc.body.innerHTML = `
      <select id="modelSelect">
        <option value="${cloudKey}">OpenCode Go</option>
        <option value="${localKey}">Qwen 2.5 7B — LM Studio</option>
      </select>
      <div id="panel"></div>
    `;

    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    (globalThis as { document: Document }).document = doc as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;

    try {
      const sel = doc.getElementById('modelSelect') as HTMLSelectElement;
      sel.value = cloudKey;

      const { mountModelMenuActions } = await import('../../src/ui/model-select-picker.ts');
      const { resolveModelHostFilterLoadUnloadValue } = await import(
        '../../src/ui/model-host-filter-context.ts'
      );

      const panel = doc.getElementById('panel')!;
      mountModelMenuActions(panel, { resolveSelectValue: () => localKey });

      const loadBtn = panel.querySelector('.model-menu-action--load-unload') as HTMLButtonElement;
      assert.ok(loadBtn);
      assert.equal(resolveModelHostFilterLoadUnloadValue(loadBtn), localKey);
      assert.notEqual(resolveModelHostFilterLoadUnloadValue(loadBtn), cloudKey);
    } finally {
      (globalThis as { document: Document }).document = prevDocument;
      (globalThis as { window: Window }).window = prevWindow;
    }
  });
});
