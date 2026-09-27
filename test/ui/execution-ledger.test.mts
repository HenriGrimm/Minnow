import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import {
  teardownExecutionLedgerBeforeChatPaint,
} from '../../src/ui/execution-ledger.ts';
import { initExecutionLedgerEntry } from '../../src/ui/execution-ledger-entry.ts';
import {
  createEmptyChatObject,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

describe('execution ledger view', () => {
  let happyDomWindow: import('happy-dom').Window | undefined;

  after(async () => {
    teardownExecutionLedgerBeforeChatPaint();
    setSessionStateForTests(null);
    if (happyDomWindow) await teardownHappyDomAsync(happyDomWindow);
  });

  test('opens from the Code view bar and renders the active task transcript', async () => {
    const { Window } = await import('happy-dom');
    const win = new Window({ url: 'http://localhost/#/app/code/chat' });
    happyDomWindow = win;
    installHappyDomGlobals(win);
    win.document.body.innerHTML = `
      <nav id="codeViews">
        <button id="btnOrchestrate"></button>
      </nav>
      <aside id="chatSidebar"></aside>
      <div id="mainColumn" class="main-column">
        <div class="chat-viewport"><main id="chatArea" class="chat-area"></main></div>
        <div class="input-bar"></div>
      </div>
    `;

    const chat = createEmptyChatObject('Current task', 'C:\\workspace');
    chat.id = 'ledger-chat';
    chat.name = 'Current task';
    chat.history = [
      { role: 'user', content: 'Run the focused test' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'cmd-1',
          type: 'function',
          function: { name: 'execute_command', arguments: '{"command":"npm test -- ledger"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'cmd-1', content: 'npm test -- ledger (exit 0)\n\nstdout:\npass' },
      { role: 'assistant', content: 'The focused test passes.' },
    ];
    setSessionStateForTests({
      version: 6,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    initExecutionLedgerEntry();
    const button = document.getElementById('btnExecutionLedger');
    assert.ok(button, 'Code view-bar entry should be created lazily');
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.ok(document.getElementById('executionLedgerRoot'));
    assert.equal(document.getElementById('btnExecutionLedger')?.getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelector('.execution-ledger__title')?.textContent, 'Execution ledger');
    assert.match(document.querySelector('.execution-ledger__prompt')?.textContent ?? '', /Run the focused test/);
    assert.match(document.querySelector('.execution-ledger__verification')?.textContent ?? '', /1 succeeded/);
    assert.match(document.querySelector('.execution-ledger__action')?.textContent ?? '', /npm test -- ledger/);
  });
});
