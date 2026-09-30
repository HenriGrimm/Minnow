import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initAgentCliView, syncAgentCliView } from '../../src/ui/agent-cli-view.ts';
import { notifyCodeStageViewChanged } from '../../src/ui/main-column-overlay.ts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

test('CLI view clears when Dev Servers owns the Code stage and returns with chat', async () => {
  const { Window } = await import('happy-dom');
  const win = new Window();
  installHappyDomGlobals(win);
  try {
    win.document.body.innerHTML = `
      <div id="mainColumn"><div class="chat-viewport"><main id="chatArea"></main></div></div>
    `;
    const chat = createEmptyChatObject('', 'C:\\workspace\\demo');
    chat.providerId = 'codex-cli';
    chat.modelId = 'gpt-5.5';
    setSessionStateForTests({
      version: 5,
      activeId: chat.id,
      sidebarCollapsed: false,
      groups: [],
      chats: [chat],
    });

    initAgentCliView();
    const button = win.document.querySelector<HTMLButtonElement>('.agent-cli-view-toggle');
    const pane = win.document.querySelector<HTMLElement>('.agent-cli-view');
    const transcript = win.document.getElementById('chatArea');
    assert.ok(button);
    assert.ok(pane);
    assert.ok(transcript);
    assert.equal(button.hidden, false);

    button.click();
    assert.equal(pane.hidden, false);
    assert.equal(transcript.hidden, true);

    transcript.classList.add('chat-area--dev-server');
    transcript.innerHTML = '<div id="devServerScreenRoot"></div>';
    syncAgentCliView();
    assert.equal(button.hidden, true);
    assert.equal(pane.hidden, true);
    assert.equal(transcript.hidden, false);

    transcript.classList.remove('chat-area--dev-server');
    transcript.replaceChildren();
    notifyCodeStageViewChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(button.hidden, false);
    assert.equal(pane.hidden, true);
    assert.equal(button.textContent, 'CLI');
  } finally {
    setSessionStateForTests(null);
    await teardownHappyDomAsync(win);
  }
});
