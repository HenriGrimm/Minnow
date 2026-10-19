import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import type { RouterConfig } from '../../src/models/routers.ts';
import { invalidateProviderCache } from '../../src/providers/store.ts';

let win: Window;

/** happy-dom has no `Option` constructor; the panel builds option rows with it. */
class OptionShim {
  constructor(text = '', value = '', defaultSelected = false, selected = false) {
    const option = win.document.createElement('option');
    option.textContent = text;
    option.value = value;
    if (defaultSelected) option.defaultSelected = true;
    if (selected) option.selected = true;
    return option as unknown as OptionShim;
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Models model pools panel auto-save', () => {
  let saves: RouterConfig[] = [];
  let serverRevision = 1;
  let loadedConfig: RouterConfig;
  let saveGate: Promise<void> | undefined;
  let onSaveStarted: (() => void) | undefined;
  const initialConfig: RouterConfig = {
    revision: 1,
    defaultRouterId: null,
    routers: [
      { id: 'r1', name: 'Build pool', enabled: true, policy: 'priority', entries: [] },
    ],
  };

  beforeEach(() => {
    win = new Window({ url: 'http://localhost/#/app/models/routers' });
    globalThis.window = win as unknown as Window & typeof globalThis;
    globalThis.document = win.document as unknown as Document;
    globalThis.HTMLElement = win.HTMLElement as unknown as typeof HTMLElement;
    globalThis.Event = win.Event as unknown as typeof Event;
    globalThis.localStorage = win.localStorage as unknown as Storage;
    globalThis.requestAnimationFrame = (callback) => { callback(0); return 0; };
    globalThis.Option = OptionShim as unknown as typeof Option;
    win.document.body.innerHTML = '<section id="modelsSection-routers" class="is-active"></section>';
    setStorageModeForTests('server');
    saves = [];
    loadedConfig = structuredClone(initialConfig);
    saveGate = undefined;
    onSaveStarted = undefined;
    invalidateProviderCache();
    serverRevision = initialConfig.revision;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      const method = init?.method ?? 'GET';
      if (target.includes('/api/generations/routers')) {
        if (method === 'PUT') {
          const body = JSON.parse(String(init?.body)) as RouterConfig;
          onSaveStarted?.();
          if (saveGate) await saveGate;
          if (body.revision !== serverRevision) {
            return new Response(
              JSON.stringify({ error: 'Routers changed in another window. Reload before saving.' }),
              { status: 409, headers: { 'Content-Type': 'application/json' } },
            );
          }
          serverRevision += 1;
          const saved = { ...body, revision: serverRevision };
          saves.push(saved);
          return json(saved);
        }
        if (target.includes('/activity')) {
          return json({
            assignments: [],
            requests: [],
            entries: [],
            availability: {},
            events: [],
          });
        }
        return json(structuredClone(loadedConfig));
      }
      if (target.includes('/api/providers/sample-cloud/models')) {
        return json({ data: ['fast-mini', 'balanced-model', 'frontier-model'].map((id) => ({ id, type: 'llm' })) });
      }
      if (target.includes('/api/providers')) {
        return json({ providers: [{ id: 'sample-cloud', label: 'Sample Cloud', enabled: true, baseUrl: 'http://localhost:12345', apiKind: 'openai-v1' }], activeProviderId: null });
      }
      return json({});
    }) as typeof fetch;
  });

  afterEach(async () => {
    win.document.body.replaceChildren();
    const { mountRoutersPanel } = await import('../../src/ui/models/routers-panel.ts');
    await mountRoutersPanel(); // Dispose the panel's polling and picker listeners.
    setStorageModeForTests(null);
    win.close();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  });

  test('edits save automatically without re-rendering the editor', async () => {
    const { mountRoutersPanel } = await import('../../src/ui/models/routers-panel.ts');
    await mountRoutersPanel();

    const nameInput = win.document.querySelector<HTMLInputElement>('.router-fields input');
    assert.ok(nameInput, 'expected the router name field');
    assert.equal(nameInput.value, 'Build pool');

    nameInput.value = 'Renamed pool';
    nameInput.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.match(
      win.document.querySelector('.router-message')?.textContent ?? '',
      /Unsaved changes/,
    );

    await new Promise((resolve) => setTimeout(resolve, 600));

    assert.equal(saves.length, 1, 'expected one debounced save');
    assert.equal(saves[0]?.routers[0]?.name, 'Renamed pool');
    assert.equal(saves[0]?.revision, 2, 'the saved revision feeds the next save');
    assert.match(win.document.querySelector('.router-message')?.textContent ?? '', /Saved/);
    assert.equal(
      win.document.querySelector<HTMLOptionElement>('.router-toolbar select option')?.text,
      'Renamed pool',
      'picker label follows the rename',
    );
    assert.equal(
      win.document.querySelector('.router-fields input'),
      nameInput,
      'the editor is not rebuilt, so focus and caret stay put',
    );

    // A second edit after a completed save must still reach the server: the
    // editor's handlers have to keep mutating the live router object.
    nameInput.value = 'Second rename';
    nameInput.dispatchEvent(new win.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(saves.length, 2, 'expected a second save');
    assert.equal(saves[1]?.routers[0]?.name, 'Second rename');
    assert.equal(saves[1]?.revision, 3);
  });

  test('users choose models, reorder them, pause them and adjust capacity without duplicate entries', async () => {
    const { mountRoutersPanel } = await import('../../src/ui/models/routers-panel.ts');
    await mountRoutersPanel();
    const click = (selector: string): void => {
      const control = win.document.querySelector<HTMLButtonElement>(selector);
      assert.ok(control, `missing control: ${selector}`); control.click();
    };
    click('.router-add-models');
    click('[aria-label="Add Fast mini from Sample Cloud"]');
    assert.equal(win.document.querySelector<HTMLButtonElement>('[aria-label="Included Fast mini from Sample Cloud"]')?.disabled, true);
    click('[aria-label="Add Balanced model from Sample Cloud"]');
    assert.equal(win.document.querySelectorAll('.router-entry').length, 2);
    click('[aria-label="Actions for rank 2"]');
    click('.mn-menu [data-id="up"]');
    assert.match(win.document.querySelector('.router-entry .model-select-trigger-text')?.textContent || '', /Balanced model/);
    const slots = win.document.querySelector<HTMLInputElement>('[aria-label="Concurrent slots for rank 1"]')!;
    slots.value = '2'; slots.dispatchEvent(new win.Event('input'));
    assert.equal(win.document.querySelectorAll('.router-entry input[type="number"]').length, 2, 'one capacity input per model');
    assert.equal(win.document.querySelector('.router-entry-details'), null, 'no duplicate More section');
    click('.router-entry-toggle');
    assert.equal(win.document.querySelector('.router-entry-toggle')?.getAttribute('aria-pressed'), 'false');
    const select = win.document.querySelector<HTMLSelectElement>('[aria-label="Model for rank 1"]')!;
    assert.ok(select.classList.contains('model-select-native'), 'uses the shared model dropdown');
    assert.equal([...select.options].some((option) => option.value.endsWith('\u001ffast-mini')), false, 'another entry cannot be selected twice');
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(saves.at(-1)?.routers[0].entries.map((entry) => ({ model: entry.modelId, slots: entry.concurrencyLimit, enabled: entry.enabled })), [
      { model: 'balanced-model', slots: 2, enabled: false }, { model: 'fast-mini', slots: 1, enabled: true },
    ]);
  });

  test('an edit made during a save uses the returned revision for the next save', async () => {
    const { mountRoutersPanel } = await import('../../src/ui/models/routers-panel.ts');
    await mountRoutersPanel();
    let release!: () => void;
    saveGate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { onSaveStarted = resolve; });
    const name = win.document.querySelector<HTMLInputElement>('[aria-label="Pool name"]')!;
    name.value = 'First'; name.dispatchEvent(new win.Event('input'));
    await started;
    name.value = 'Latest'; name.dispatchEvent(new win.Event('input'));
    release();
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(saves.length, 2);
    assert.equal(saves[1].revision, 3);
    assert.equal(saves[1].routers[0].name, 'Latest');
    assert.equal(name.value, 'Latest');
    assert.equal(win.document.querySelector('.router-message')?.textContent, 'Saved');
  });

  test('task matching preserves unavailable evaluators and pausing a default pool clears its default', async () => {
    loadedConfig.defaultRouterId = 'r1';
    loadedConfig.routers[0].policy = 'evaluate';
    loadedConfig.routers[0].evaluator = { providerId: 'sample-cloud', modelId: 'unlisted-judge' };
    loadedConfig.routers[0].entries = [{ id: 'model', providerId: 'sample-cloud', modelId: 'balanced-model', enabled: true, concurrencyLimit: 1 }];
    const { mountRoutersPanel } = await import('../../src/ui/models/routers-panel.ts');
    await mountRoutersPanel();
    const evaluator = win.document.querySelector<HTMLSelectElement>('[aria-label="Task evaluator model"]')!;
    assert.match(evaluator.selectedOptions[0].textContent || '', /unlisted-judge.*unavailable/);
    const taskTypes = win.document.querySelector('[aria-label="Task types for rank 1"]')!;
    assert.equal(taskTypes.closest('.router-entry-identity'), null, 'assignments sit below the model controls');
    assert.ok(taskTypes.closest('.router-entry-routing')?.querySelector('[aria-label="Tier for rank 1"]'));
    assert.equal(taskTypes.querySelector<HTMLElement>('.router-task-popover')?.hidden, true);
    taskTypes.querySelector<HTMLButtonElement>('.router-task-types__trigger')!.click();
    taskTypes.querySelector<HTMLInputElement>('[value="ux-design"]')!.click();
    taskTypes.querySelector<HTMLInputElement>('[value="coding"]')!.click();
    assert.match(taskTypes.querySelector('.router-task-types__value')?.textContent || '', /Coder, UX Design/);
    taskTypes.querySelector<HTMLButtonElement>('.router-task-types__done')!.click();
    assert.equal(taskTypes.querySelector<HTMLElement>('.router-task-popover')?.hidden, true);
    win.document.querySelector<HTMLButtonElement>('.router-pool-enabled')!.click();
    assert.equal(win.document.querySelector('.router-default-toggle'), null);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(saves.at(-1)?.defaultRouterId, null);
    assert.equal(saves.at(-1)?.routers[0].evaluator?.modelId, 'unlisted-judge');
    assert.deepEqual(saves.at(-1)?.routers[0].entries[0].taskTypes, ['coding', 'ux-design']);
  });
});
