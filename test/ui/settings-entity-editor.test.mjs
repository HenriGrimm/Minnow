import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import { Window } from 'happy-dom';

function setupDom() {
  const window = new Window();
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  return window;
}

describe('settings-entity-editor work agent config', () => {
  afterEach(() => {
    mock.restoreAll();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.HTMLElement;
    delete globalThis.Node;
  });

  test('save preserves disabled=false when toggle is unchecked', async () => {
    setupDom();
    const container = document.createElement('div');
    document.body.appendChild(container);

    /** @type {{ disabled?: boolean } | null} */
    let savedPatch = null;

    mock.method(globalThis, 'fetch', async (_url, init) => {
      savedPatch = JSON.parse(String(init?.body ?? '{}'));
      return {
        ok: true,
        async json() {
          return {
            agent: {
              id: 'test-agent',
              label: 'Test Agent',
              disabled: savedPatch?.disabled ?? false,
            },
          };
        },
      };
    });

    const { mountWorkAgentConfigEditor } = await import(
      '../../src/ui/settings-entity-editor.ts'
    );

    mountWorkAgentConfigEditor(container, {
      agentId: 'test-agent',
      initialProviderId: null,
      initialModelId: null,
      initialDisabled: false,
      initialMaxInputTokens: null,
      initialContextPolicy: 'slide',
    });

    const disabledCb = container.querySelector('input[type="checkbox"]');
    assert.ok(disabledCb);
    assert.equal(disabledCb.checked, false);

    // Settings save on change now (MIN-109) — no Save button to click.
    disabledCb.dispatchEvent(new window.Event('change', { bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(savedPatch, 'expected patchWorkAgentOverride fetch call');
    assert.equal(savedPatch.disabled, false);
  });
});
