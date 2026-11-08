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

  test('lists the one agent\'s prompts, workflow skills and boards — no modes or agent types', async () => {
    const { loadAgentCenterCards } = await import('../../src/ui/settings-agent-center.ts');
    const cards = loadAgentCenterCards();
    assert.deepEqual(
      cards.map((card) => [card.kind, card.title]),
      [
        ['prompts', 'System prompt'],
        ['prompts', 'Tool usage'],
        ['prompts', 'Local model guidance'],
        ['skills', '/ask'],
        ['skills', '/plan'],
        ['skills', '/debug'],
        ['boards', 'Boards'],
      ],
    );
  });

  test('renders prompt cards, the local guidance control and sub-agent limits', async () => {
    document.body.innerHTML = `
      <div id="settingsAgentCenterBody"></div>
      <details id="settingsBasePromptPanel"></details>
    `;

    const { renderAgentCenterPanel } = await import('../../src/ui/settings-agent-center.ts');
    const content = await renderAgentCenterPanel(
      document.getElementById('settingsAgentCenterBody'),
    );
    assert.ok(content);
    assert.ok(content.querySelector('[data-agent-card="prompt:base"]'));
    assert.ok(content.querySelector('[data-settings-search-key="agents.localModelGuidance"]'));
    assert.ok(content.querySelector('[data-settings-search-key="agents.subAgents.limits"]'));
    assert.equal(content.querySelector('[data-settings-search-key="agents.modes"]'), null);
    assert.equal(content.querySelector('[data-settings-search-key="agents.workAgents"]'), null);

    const prompt = document.getElementById('settingsBasePromptPanel');
    const cards = content.querySelector('[data-agent-card="prompt:base"]');
    assert.ok(prompt && cards);
    assert.equal(
      cards.compareDocumentPosition(prompt) & window.Node.DOCUMENT_POSITION_FOLLOWING,
      window.Node.DOCUMENT_POSITION_FOLLOWING,
      'the composed-prompt disclosure comes after the cards',
    );
  });
});
