import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

describe('settings agent center', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    const window = new Window();
    globalThis.window = window as unknown as Window & typeof globalThis;
    globalThis.document = window.document as unknown as Document;
    globalThis.localStorage = window.localStorage;
    globalThis.HTMLElement = window.HTMLElement as unknown as typeof HTMLElement;
    globalThis.Node = window.Node as unknown as typeof Node;
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      if (String(input) === '/api/work-agents') {
        return new Response(JSON.stringify({ agents: [] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const { setStorageModeForTests } = await import('../../src/config/storage-mode.ts');
    const { resetSubAgentConfigCache } = await import('../../src/agents/sub-agent-config.ts');
    setStorageModeForTests('localStorage');
    resetSubAgentConfigCache();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    const { setStorageModeForTests } = await import('../../src/config/storage-mode.ts');
    setStorageModeForTests(null);
    document.body.replaceChildren();
  });

  test('shows only composer modes', async () => {
    const { loadAgentCenterCards } = await import('../../src/ui/settings-agent-center.ts');
    const cards = await loadAgentCenterCards();
    assert.deepEqual(
      cards.filter((card) => card.kind === 'modes').map((card) => card.title),
      ['General', 'Build', 'Plan', 'Debug'],
    );
  });

  test('places the shared system prompt before modes', async () => {
    document.body.innerHTML = `
      <div id="settingsAgentCenterBody"></div>
      <details id="settingsBasePromptPanel"></details>
    `;

    const { renderAgentCenterPanel } = await import('../../src/ui/settings-agent-center.ts');
    const content = await renderAgentCenterPanel(
      document.getElementById('settingsAgentCenterBody'),
    );
    assert.ok(content);

    const prompt = document.getElementById('settingsBasePromptPanel');
    const modes = content.querySelector('[data-settings-search-key="agents.modes"]');
    assert.ok(prompt);
    assert.ok(modes);
    assert.equal(
      prompt.compareDocumentPosition(modes) & window.Node.DOCUMENT_POSITION_FOLLOWING,
      window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});
