/**
 * Model combobox menu: load-state dots per row (feature 12–13 / custom picker).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const modelSelectCss = readFileSync(join(root, 'src/styles/model-select.css'), 'utf8');
const topbarCss = readFileSync(join(root, 'src/styles/topbar.css'), 'utf8');

describe('syncModelSelectPicker', () => {
  test('groups Cursor reasoning and fast variants while selecting the exact CLI model ID', async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML = `
      <select id="modelSelect">
        <option value="cursor-agent-cli\u001fclaude-opus-5-5-medium" data-provider-id="cursor-agent-cli">Claude opus 5 5 medium — Cursor Agent</option>
        <option value="cursor-agent-cli\u001fclaude-opus-5-5-medium-fast" data-provider-id="cursor-agent-cli">Claude opus 5 5 medium fast — Cursor Agent</option>
        <option value="cursor-agent-cli\u001fclaude-opus-5-5-high" data-provider-id="cursor-agent-cli">Claude opus 5 5 high — Cursor Agent</option>
        <option value="cursor-agent-cli\u001fclaude-opus-5-5-high-fast" data-provider-id="cursor-agent-cli">Claude opus 5 5 high fast — Cursor Agent</option>
        <option value="cursor-agent-cli\u001fcomposer-2.5" data-provider-id="cursor-agent-cli">Composer 2.5 — Cursor Agent</option>
      </select>
      <ul id="menu"></ul>
    `;
    const previous = { document: globalThis.document, window: globalThis.window, localStorage: globalThis.localStorage };
    (globalThis as { document: Document }).document = doc as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;
    (globalThis as { localStorage: Storage }).localStorage = win.localStorage as unknown as Storage;
    try {
      const { renderModelSelectMenuRows, setModelHostFilter, setModelLibraryFilter, setModelSearchQuery } =
        await import('../../src/ui/model-select-picker.ts');
      setModelHostFilter('all');
      setModelLibraryFilter('all');
      setModelSearchQuery('');
      const select = doc.getElementById('modelSelect') as HTMLSelectElement;
      const menu = doc.getElementById('menu') as HTMLUListElement;
      let picked = '';
      renderModelSelectMenuRows(menu, select, value => { picked = value; });
      assert.equal(menu.querySelectorAll('.model-select-option').length, 2);
      const row = menu.querySelector<HTMLElement>('.model-select-option')!;
      assert.match(row.textContent ?? '', /Claude opus 5 5 — Cursor Agent/);
      assert.equal(menu.querySelector('.model-select-cursor-variants'), null);
      row.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
      assert.equal(picked, 'cursor-agent-cli\u001fclaude-opus-5-5-medium');
    } finally {
      (globalThis as { document: Document }).document = previous.document;
      (globalThis as { window: Window }).window = previous.window;
      (globalThis as { localStorage: Storage }).localStorage = previous.localStorage;
    }
  });

  test('groups Cursor models that have both Thinking and regular reasoning variants', async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML = `
      <select id="modelSelect">
        <option value="cursor-agent-cli\u001fclaude-opus-4-8-low" data-provider-id="cursor-agent-cli">Claude Opus 4.8 1M Low — Cursor Agent</option>
        <option value="cursor-agent-cli\u001fclaude-opus-4-8-low-fast" data-provider-id="cursor-agent-cli">Claude Opus 4.8 1M Low Fast — Cursor Agent</option>
        <option value="cursor-agent-cli\u001fclaude-opus-4-8-thinking-low" data-provider-id="cursor-agent-cli">Claude Opus 4.8 1M Low Thinking — Cursor Agent</option>
        <option value="cursor-agent-cli\u001fclaude-opus-4-8-thinking-low-fast" data-provider-id="cursor-agent-cli">Claude Opus 4.8 1M Low Thinking Fast — Cursor Agent</option>
        <option value="cursor-agent-cli\u001fclaude-opus-4-8-thinking-high" data-provider-id="cursor-agent-cli">Claude Opus 4.8 1M Thinking — Cursor Agent</option>
      </select>
      <ul id="menu"></ul>
    `;
    const previous = { document: globalThis.document, window: globalThis.window, localStorage: globalThis.localStorage };
    (globalThis as { document: Document }).document = doc as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;
    (globalThis as { localStorage: Storage }).localStorage = win.localStorage as unknown as Storage;
    try {
      const { renderModelSelectMenuRows, setModelHostFilter, setModelLibraryFilter, setModelSearchQuery } =
        await import('../../src/ui/model-select-picker.ts');
      setModelHostFilter('all');
      setModelLibraryFilter('all');
      setModelSearchQuery('');
      const select = doc.getElementById('modelSelect') as HTMLSelectElement;
      const menu = doc.getElementById('menu') as HTMLUListElement;
      let picked = '';
      renderModelSelectMenuRows(menu, select, value => { picked = value; });
      const rows = menu.querySelectorAll<HTMLElement>('.model-select-option');
      assert.equal(rows.length, 2);
      assert.match(rows[0].textContent ?? '', /Claude Opus 4\.8 1M — Cursor Agent/);
      assert.match(rows[1].textContent ?? '', /Claude Opus 4\.8 1M Thinking — Cursor Agent/);
      assert.equal(menu.querySelector('.model-select-cursor-variants'), null);
      rows[1].dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
      assert.equal(picked, 'cursor-agent-cli\u001fclaude-opus-4-8-thinking-low');
    } finally {
      (globalThis as { document: Document }).document = previous.document;
      (globalThis as { window: Window }).window = previous.window;
      (globalThis as { localStorage: Storage }).localStorage = previous.localStorage;
    }
  });

  test('Claude catalog aliases retain versions and render under Anthropic through the client pipeline', async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML = `
      <select id="modelSelect"></select>
      <button id="modelSelectTrigger"><span id="modelSelectTriggerText"></span></button>
      <ul id="modelSelectMenu"></ul>
    `;
    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    const prevLocalStorage = globalThis.localStorage;
    (globalThis as { document: Document }).document = doc as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;
    (globalThis as { localStorage: Storage }).localStorage = win.localStorage as unknown as Storage;
    try {
      const { listAgentCliModelsWithConfig } = await import('../../server/models/agent-cli-catalog.js');
      const { normalizeModelsForUi } = await import('../../src/providers/fetch-models.ts');
      const { buildTopBarModelOptionHtml } = await import('../../src/lib/format-model-label.ts');
      const { encodeModelSelectKey } = await import('../../src/lib/model-select-key.ts');
      const { modelCache } = await import('../../src/app-state.ts');
      const { syncModelSelectPicker, setModelHostFilter, setModelLibraryFilter, setModelSearchQuery } =
        await import('../../src/ui/model-select-picker.ts');
      const provider = {
        id: 'claude-code-cli', label: 'Claude Code', baseUrl: '', apiKind: 'agent-cli-v1' as const,
        enabled: true, hasApiKey: false, hasBearer: false,
      };
      const raw = await listAgentCliModelsWithConfig(provider.id, { cliVersion: '2.1.284 (Claude Code)' });
      const models = normalizeModelsForUi(provider, raw);
      const sel = doc.getElementById('modelSelect') as HTMLSelectElement;
      modelCache.clear();
      sel.innerHTML = models.map(model => {
        const value = encodeModelSelectKey(provider.id, model.id);
        modelCache.set(value, model);
        return buildTopBarModelOptionHtml({ value, providerId: provider.id, providerLabel: provider.label, model });
      }).join('') + Array.from({ length: 10 }, (_, i) => `<option value="unknown-${i}">Unknown ${i}</option>`).join('');
      setModelHostFilter('all');
      setModelLibraryFilter('all');
      setModelSearchQuery('');
      sel.value = encodeModelSelectKey(provider.id, 'opus');
      syncModelSelectPicker();

      const menu = doc.getElementById('modelSelectMenu')!;
      const header = menu.querySelector('[data-producer-slug="anthropic"]');
      assert.ok(header);
      assert.ok(header.querySelector('.model-producer-logo'));
      const expectedLabels = new Map([
        ['sonnet', 'Claude Sonnet 5.5 (CLI default)'],
        ['opus', 'Claude Opus 5.5 (CLI default)'],
        ['haiku', 'Claude Haiku 4.5 (CLI default)'],
      ]);
      for (const [alias, label] of expectedLabels) {
        const key = encodeModelSelectKey(provider.id, alias);
        const row = [...menu.querySelectorAll<HTMLElement>('.model-select-option')].find(el => el.dataset.value === key)!;
        assert.ok(row);
        assert.ok(row.querySelector('.model-producer-logo'));
        assert.match(row.textContent ?? '', new RegExp(label.replace(/[().]/g, '\\$&')));
        let previous = row.previousElementSibling;
        while (previous && !previous.hasAttribute('data-producer-slug')) previous = previous.previousElementSibling;
        assert.equal((previous as HTMLElement)?.dataset.producerSlug, 'anthropic');
      }
      assert.match(doc.getElementById('modelSelectTriggerText')?.textContent ?? '', /Claude Opus 5\.5/);
      assert.equal(sel.value, encodeModelSelectKey(provider.id, 'opus'));

      setModelSearchQuery('Anthropic');
      syncModelSelectPicker();
      assert.equal(menu.querySelectorAll('.model-select-option').length, models.length);
    } finally {
      const { setModelSearchQuery } = await import('../../src/ui/model-select-picker.ts');
      setModelSearchQuery('');
      (globalThis as { document: Document }).document = prevDocument;
      (globalThis as { window: Window }).window = prevWindow;
      (globalThis as { localStorage: Storage }).localStorage = prevLocalStorage;
    }
  });

  test('renders load dots in menu from model cache', async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML = `
      <div class="model-select-inner">
        <span class="model-state-dot model-load-dot" id="modelStateDot"></span>
        <select id="modelSelect" class="model-select-native">
          <option value="a/model-a" title="a/model-a — loaded">Model A · Q4</option>
          <option value="b/model-b" title="b/model-b — not loaded">Model B</option>
        </select>
        <button type="button" id="modelSelectTrigger"><span id="modelSelectTriggerText"></span></button>
        <ul id="modelSelectMenu" class="model-select-menu hidden" role="listbox"></ul>
      </div>
    `;

    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    (globalThis as { document: Document }).document = doc as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;

    try {
      const { modelCache } = await import('../../src/app-state.ts');
      const { syncModelSelectPicker } = await import('../../src/ui/model-select-picker.ts');

      modelCache.clear();
      modelCache.set('a/model-a', { id: 'a/model-a', state: 'loaded' });
      modelCache.set('b/model-b', { id: 'b/model-b', state: 'not loaded' });

      const sel = doc.getElementById('modelSelect') as HTMLSelectElement;
      sel.value = 'a/model-a';

      syncModelSelectPicker();

      const menu = doc.getElementById('modelSelectMenu');
      const items = menu?.querySelectorAll('.model-select-option');
      assert.equal(items?.length, 2);

      const loadedDot = items?.[0]?.querySelector('.model-load-dot') as HTMLElement;
      const unloadedDot = items?.[1]?.querySelector('.model-load-dot') as HTMLElement;
      assert.equal(loadedDot?.dataset.loadState, 'loaded');
      assert.equal(unloadedDot?.dataset.loadState, 'unloaded');

      const triggerText = doc.getElementById('modelSelectTriggerText');
      assert.equal(triggerText?.textContent, 'Model A · Q4');
      assert.equal(triggerText?.getAttribute('title'), 'a/model-a — loaded');

      const firstRow = items?.[0] as HTMLElement | undefined;
      const secondRow = items?.[1] as HTMLElement | undefined;
      assert.equal(firstRow?.getAttribute('title'), 'a/model-a — loaded');
      assert.equal(secondRow?.getAttribute('title'), 'b/model-b — not loaded');
      assert.equal(
        firstRow?.querySelector('.model-select-option-label')?.getAttribute('title'),
        'a/model-a — loaded',
      );
    } finally {
      (globalThis as { document: Document }).document = prevDocument;
      (globalThis as { window: Window }).window = prevWindow;
    }
  });

  test('renders capability badges when model cache has capabilities', async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML = `
      <div class="model-select-inner">
        <select id="modelSelect" class="model-select-native">
          <option value="vision/model">Vision Model</option>
        </select>
        <button type="button" id="modelSelectTrigger"><span id="modelSelectTriggerText"></span></button>
        <ul id="modelSelectMenu" class="model-select-menu hidden" role="listbox"></ul>
      </div>
    `;

    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    (globalThis as { document: Document }).document = doc as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;

    try {
      const { modelCache } = await import('../../src/app-state.ts');
      const { syncModelSelectPicker } = await import('../../src/ui/model-select-picker.ts');

      modelCache.clear();
      modelCache.set('vision/model', {
        id: 'vision/model',
        type: 'vlm',
        state: 'loaded',
        capabilities: {
          vision: true,
          tools: true,
          streaming: true,
          grammar: null,
          reasoning: null,
          contextLength: 32768,
          loadState: 'loaded',
        },
      });

      syncModelSelectPicker();
      const badges = doc.querySelectorAll('.model-cap-badge');
      assert.ok(badges.length >= 2);
      const texts = [...badges].map((el) => el.textContent);
      assert.ok(texts.includes('Tools'));
      assert.ok(texts.includes('Vision'));
    } finally {
      (globalThis as { document: Document }).document = prevDocument;
      (globalThis as { window: Window }).window = prevWindow;
    }
  });

  test('falls back to canonical model id for tooltips when option title is missing', async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML = `
      <div class="model-select-inner">
        <select id="modelSelect" class="model-select-native">
          <option value="vendor/long-model-id">Short label</option>
        </select>
        <button type="button" id="modelSelectTrigger"><span id="modelSelectTriggerText"></span></button>
        <ul id="modelSelectMenu" class="model-select-menu hidden" role="listbox"></ul>
      </div>
    `;

    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    (globalThis as { document: Document }).document = doc as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;

    try {
      const { syncModelSelectPicker } = await import('../../src/ui/model-select-picker.ts');
      const sel = doc.getElementById('modelSelect') as HTMLSelectElement;
      sel.value = 'vendor/long-model-id';
      syncModelSelectPicker();

      const row = doc.querySelector('.model-select-option') as HTMLElement | null;
      const triggerText = doc.getElementById('modelSelectTriggerText');
      assert.equal(row?.getAttribute('title'), 'vendor/long-model-id');
      assert.equal(triggerText?.getAttribute('title'), 'vendor/long-model-id');
    } finally {
      (globalThis as { document: Document }).document = prevDocument;
      (globalThis as { window: Window }).window = prevWindow;
    }
  });

  test('filters models by local vs cloud provider host', async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML = `
      <div class="model-select-inner">
        <select id="modelSelect" class="model-select-native">
          <option value="lm-studio-local/local-model" data-provider-id="lm-studio-local" data-provider-host="local">Local model — LM Studio</option>
          <option value="openrouter/cloud-model" data-provider-id="openrouter" data-provider-host="cloud">Cloud model — OpenRouter</option>
        </select>
        <button type="button" id="modelSelectTrigger"><span id="modelSelectTriggerText"></span></button>
        <ul id="modelSelectMenu" class="model-select-menu hidden" role="listbox"></ul>
      </div>
    `;

    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    const prevLocalStorage = globalThis.localStorage;
    (globalThis as { document: Document }).document = doc as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;
    (globalThis as { localStorage: Storage }).localStorage = win.localStorage;

    try {
      const { renderModelSelectMenuRows, setModelHostFilter } = await import(
        '../../src/ui/model-select-picker.ts'
      );

      const sel = doc.getElementById('modelSelect') as HTMLSelectElement;
      const menu = doc.getElementById('modelSelectMenu') as HTMLUListElement;

      setModelHostFilter('local');
      renderModelSelectMenuRows(menu, sel);
      assert.equal(menu.querySelectorAll('.model-select-option').length, 1);
      assert.match(menu.textContent ?? '', /Local model/);

      setModelHostFilter('cloud');
      renderModelSelectMenuRows(menu, sel);
      assert.equal(menu.querySelectorAll('.model-select-option').length, 1);
      assert.match(menu.textContent ?? '', /Cloud model/);

      setModelHostFilter('all');
      renderModelSelectMenuRows(menu, sel);
      assert.equal(menu.querySelectorAll('.model-select-option').length, 2);
    } finally {
      (globalThis as { document: Document }).document = prevDocument;
      (globalThis as { window: Window }).window = prevWindow;
      (globalThis as { localStorage: Storage }).localStorage = prevLocalStorage;
    }
  });

  test('shouldKeepModelMenuOpenAfterSelect stays open for unloadable local models', async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML = `
      <select id="modelSelect">
        <option value="local/unloaded" data-supports-load-unload="1">Unloaded local</option>
        <option value="local/loaded" data-supports-load-unload="1">Loaded local</option>
        <option value="cloud/remote" data-provider-host="cloud">Cloud model</option>
      </select>
    `;

    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    const prevFetch = globalThis.fetch;
    (globalThis as { document: Document }).document = doc as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/config/ping')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return prevFetch(input);
    };

    try {
      const { detectConfigServer } = await import('../../src/config/storage-mode.ts');
      await detectConfigServer();

      const { modelCache } = await import('../../src/app-state.ts');
      const { shouldKeepModelMenuOpenAfterSelect } = await import(
        '../../src/ui/model-select-picker.ts'
      );

      modelCache.clear();
      modelCache.set('local/unloaded', { id: 'local/unloaded', state: 'not loaded' });
      modelCache.set('local/loaded', { id: 'local/loaded', state: 'loaded' });

      assert.equal(shouldKeepModelMenuOpenAfterSelect('local/unloaded'), true);
      assert.equal(shouldKeepModelMenuOpenAfterSelect('local/loaded'), false);
      assert.equal(shouldKeepModelMenuOpenAfterSelect('cloud/remote'), false);
    } finally {
      (globalThis as { document: Document }).document = prevDocument;
      (globalThis as { window: Window }).window = prevWindow;
      globalThis.fetch = prevFetch;
    }
  });

  test('menu rows keep full optionText for long labels (BUG-017)', async () => {
    const longLabel =
      'Qwen3.6 35B A3b · Q4_K_M · extended context variant name';
    const { Window } = await import('happy-dom');
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML = `
      <div class="model-select-inner">
        <select id="modelSelect" class="model-select-native">
          <option value="qwen/qwen3.6-35b-a3b" title="qwen/qwen3.6-35b-a3b — loaded">${longLabel}</option>
        </select>
        <button type="button" id="modelSelectTrigger"><span id="modelSelectTriggerText"></span></button>
        <ul id="modelSelectMenu" class="model-select-menu hidden" role="listbox"></ul>
      </div>
    `;

    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    (globalThis as { document: Document }).document = doc as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;

    try {
      const { syncModelSelectPicker } = await import('../../src/ui/model-select-picker.ts');
      const sel = doc.getElementById('modelSelect') as HTMLSelectElement;
      sel.value = 'qwen/qwen3.6-35b-a3b';
      syncModelSelectPicker();

      const menuLabel = doc.querySelector('.model-select-option-label');
      assert.equal(menuLabel?.textContent, longLabel);
      assert.doesNotMatch(menuLabel?.textContent ?? '', /…/);

      const triggerText = doc.getElementById('modelSelectTriggerText');
      assert.equal(triggerText?.textContent, longLabel);
      assert.equal(triggerText?.getAttribute('title'), 'qwen/qwen3.6-35b-a3b — loaded');
    } finally {
      (globalThis as { document: Document }).document = prevDocument;
      (globalThis as { window: Window }).window = prevWindow;
    }
  });
});

describe('syncAuxiliaryModelSelectCombobox', () => {
  for (const hasModels of [true, false]) {
    test(`routing reset remains selectable with ${hasModels ? 'filtered' : 'no'} catalog models`, async () => {
      const { Window } = await import('happy-dom');
      const win = new Window();
      const previous = { document: globalThis.document, window: globalThis.window, localStorage: globalThis.localStorage };
      globalThis.document = win.document as unknown as Document;
      globalThis.window = win as unknown as Window & typeof globalThis.window;
      globalThis.localStorage = win.localStorage as unknown as Storage;
      try {
        const picker = await import('../../src/ui/model-select-picker.ts');
        picker.setModelHostFilter('local');
        picker.setModelLibraryFilter('library');
        picker.setModelSearchQuery('no matches');
        const select = document.createElement('select');
        select.innerHTML = '<option value="" data-model-select-reset="true">(use current model)</option>';
        if (hasModels) {
          const model = document.createElement('option');
          model.value = 'pinned-host\u001fpinned-model';
          model.text = 'Pinned model';
          select.appendChild(model);
          select.value = model.value;
        }
        document.body.appendChild(select);
        // Use this DOM's Event constructor for the picker's change event.
        const previousEvent = globalThis.Event;
        globalThis.Event = win.Event as unknown as typeof Event;
        try {
          let changes = 0;
          select.addEventListener('change', () => { changes++; });
          picker.mountAuxiliaryModelSelectCombobox(select);
          const trigger = document.querySelector<HTMLButtonElement>('.model-select-trigger')!;
          assert.equal(trigger.disabled, false);
          trigger.click();
          const reset = document.querySelector<HTMLElement>('.model-select-option[data-value=""]')!;
          assert.ok(reset);
          assert.equal(reset.textContent, '(use current model)');
          reset.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
          assert.equal(select.value, '');
          assert.equal(changes, 1, 'reset saves even when the pinned model is absent from the catalog');
          assert.equal(document.querySelector('.model-select-trigger-text')?.textContent, '(use current model)');
          assert.equal(trigger.getAttribute('aria-expanded'), 'false');
        } finally {
          globalThis.Event = previousEvent;
        }
      } finally {
        const picker = await import('../../src/ui/model-select-picker.ts');
        picker.setModelHostFilter('all');
        picker.setModelLibraryFilter('all');
        picker.setModelSearchQuery('');
        globalThis.document = previous.document;
        globalThis.window = previous.window;
        globalThis.localStorage = previous.localStorage;
      }
    });
  }

  test('updates trigger label immediately after picking a different model', async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML = `
      <div id="host">
        <select id="auxModelSelect" aria-label="Compare model">
          <option value="a/model-a">Model A · Q4</option>
          <option value="b/model-b">Model B · Q8</option>
        </select>
      </div>
    `;

    const prevDocument = globalThis.document;
    const prevWindow = globalThis.window;
    (globalThis as { document: Document }).document = doc as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;

    try {
      const {
        mountAuxiliaryModelSelectCombobox,
        setModelHostFilter,
      } = await import('../../src/ui/model-select-picker.ts');

      setModelHostFilter('all');

      const select = doc.getElementById('auxModelSelect') as HTMLSelectElement;
      select.value = 'a/model-a';
      mountAuxiliaryModelSelectCombobox(select);

      const triggerText = doc.querySelector('.model-select-trigger-text');
      assert.equal(triggerText?.textContent, 'Model A · Q4');

      select.value = 'b/model-b';
      select.dispatchEvent(new win.Event('change', { bubbles: true }));
      assert.equal(triggerText?.textContent, 'Model B · Q8');
    } finally {
      (globalThis as { document: Document }).document = prevDocument;
      (globalThis as { window: Window }).window = prevWindow;
    }
  });
});

describe('model picker truncation CSS (BUG-017)', () => {
  test('menu option labels avoid ellipsis clipping', () => {
    const block = modelSelectCss.match(/\.model-select-option-label\s*\{[^}]+\}/s);
    assert.ok(block, 'expected .model-select-option-label rule');
    assert.doesNotMatch(block[0], /text-overflow:\s*ellipsis/);
    assert.match(block[0], /overflow:\s*visible/);
  });

  test('menu can grow to max-content with a viewport cap', () => {
    const block = modelSelectCss.match(/\.model-select-menu\s*\{[^}]+\}/s);
    assert.ok(block, 'expected .model-select-menu rule');
    assert.match(block[0], /width:\s*max-content/);
    assert.match(block[0], /max-width:\s*min\(90vw,\s*32rem\)/);
  });

  test('closed trigger keeps ellipsis; model-wrap width increased', () => {
    const triggerBlock = modelSelectCss.match(/\.model-select-trigger-text\s*\{[^}]+\}/s);
    assert.ok(triggerBlock, 'expected .model-select-trigger-text rule');
    assert.match(triggerBlock[0], /text-overflow:\s*ellipsis/);

    const wrapBlock = topbarCss.match(/\.model-wrap\s*\{[^}]+\}/s);
    assert.ok(wrapBlock, 'expected .model-wrap rule');
    assert.match(wrapBlock[0], /max-width:\s*420px/);
  });

  test('capability matrix rail constrains auxiliary model menu to field width', () => {
    const capMatrixCss = readFileSync(
      join(root, 'src/styles/settings-capability-matrix.css'),
      'utf8',
    );
    const menuBlock = capMatrixCss.match(
      /\.cap-matrix-roster__field \.model-select-menu\s*\{[^}]+\}/s,
    );
    assert.ok(menuBlock, 'expected scoped cap-matrix model menu rule');
    assert.match(menuBlock[0], /width:\s*100%/);
    assert.match(menuBlock[0], /max-width:\s*none/);

    const labelBlock = capMatrixCss.match(
      /\.cap-matrix-roster__field \.model-select-option-label\s*\{[^}]+\}/s,
    );
    assert.ok(labelBlock, 'expected scoped cap-matrix option label rule');
    assert.match(labelBlock[0], /text-overflow:\s*ellipsis/);
  });
});
