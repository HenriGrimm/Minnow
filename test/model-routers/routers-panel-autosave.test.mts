import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import type { RouterConfig } from '../../src/models/routers.ts';

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
    globalThis.Option = OptionShim as unknown as typeof Option;
    win.document.body.innerHTML = '<section id="modelsSection-routers" class="is-active"></section>';
    setStorageModeForTests('server');
    saves = [];
    serverRevision = initialConfig.revision;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      const method = init?.method ?? 'GET';
      if (target.includes('/api/generations/routers')) {
        if (method === 'PUT') {
          const body = JSON.parse(String(init?.body)) as RouterConfig;
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
        return json(structuredClone(initialConfig));
      }
      if (target.includes('/api/providers')) {
        return json({ providers: [], activeProviderId: null });
      }
      return json({});
    }) as typeof fetch;
  });

  afterEach(() => {
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
});
