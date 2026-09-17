/**
 * Model menu actions: the per-row Load button is gone, Load lives in the menu,
 * and Open settings hands the model off to Models → My Models load settings.
 */

import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';

const LIBRARY_PROVIDER_ID = 'minnow-library';
const LIBRARY_MODEL_ID = 'gguf:acme/model:weights/model-Q4_K_M.gguf';

/** Sections openModels was asked to show. */
const openedSections: string[] = [];
/** Inspector calls recorded by the mocked Models inspector. */
const inspected: Array<{ id: string; tab: string }> = [];

mock.module('../../src/ui/models-page.ts', {
  namedExports: {
    openModels: (section?: string) => {
      openedSections.push(section ?? '');
    },
  },
});

mock.module('../../src/ui/models/inspector.ts', {
  namedExports: {
    showModelInInspector: (id: string, tab: string) => {
      inspected.push({ id, tab });
    },
  },
});

/** Empty JSON reply so the real Models store scan fails fast instead of hitting the network. */
async function emptyJson(): Promise<Response> {
  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('model menu actions', () => {
  test('Open settings opens My Models load settings for a library model', async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    win.fetch = emptyJson;
    const doc = win.document;
    const selectValue = encodeModelSelectKey(LIBRARY_PROVIDER_ID, LIBRARY_MODEL_ID);
    doc.body.innerHTML = `
      <select id="modelSelect">
        <option value="${selectValue}">Model Q4_K_M</option>
      </select>
    `;

    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    (globalThis as { document: Document }).document = doc as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;

    try {
      const { openModelLoadSettings } = await import('../../src/ui/model-select-picker.ts');
      openedSections.length = 0;
      inspected.length = 0;

      await openModelLoadSettings(selectValue);

      assert.deepEqual(openedSections, ['installed']);
      assert.deepEqual(inspected, [{ id: LIBRARY_MODEL_ID, tab: 'load' }]);
    } finally {
      (globalThis as { document: Document }).document = prevDocument;
      (globalThis as { window: Window }).window = prevWindow;
    }
  });

  test('Open settings stays on My Models when the value has no library row', async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    win.fetch = emptyJson;
    const doc = win.document;
    doc.body.innerHTML = `
      <select id="modelSelect">
        <option value="openai::gpt-4o">GPT-4o</option>
      </select>
    `;

    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    (globalThis as { document: Document }).document = doc as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;

    try {
      const { openModelLoadSettings } = await import('../../src/ui/model-select-picker.ts');
      openedSections.length = 0;
      inspected.length = 0;

      await openModelLoadSettings('openai::gpt-4o');

      assert.deepEqual(openedSections, ['installed']);
      assert.deepEqual(inspected, []);
    } finally {
      (globalThis as { document: Document }).document = prevDocument;
      (globalThis as { window: Window }).window = prevWindow;
    }
  });
});
