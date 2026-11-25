import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { CHAT_SIDEBAR_CHANGED_EVENT } from '../../src/ui/layout-events.ts';
import { initCodeViewsChatsToggle } from '../../src/ui/code-views-chats-toggle.ts';
import { resetMobileLayoutForTests } from '../../src/ui/mobile-layout.ts';
import {
  createEmptyChatObject,
  sessionState,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

describe('code views chats toggle', () => {
  let happyDomWindow: import('happy-dom').Window | undefined;

  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    happyDomWindow = win;
    installHappyDomGlobals(win);
    resetMobileLayoutForTests();

    win.document.body.innerHTML = `
      <nav class="code-views" id="codeViews">
        <button type="button" class="code-views__btn" id="btnCodeViewsChats"></button>
      </nav>
      <aside class="chat-sidebar" id="chatSidebar"></aside>
    `;

    initCodeViewsChatsToggle();
  });

  afterEach(async () => {
    setSessionStateForTests(null);
    if (happyDomWindow) await teardownHappyDomAsync(happyDomWindow);
  });

  test('syncs aria when chat sidebar visibility changes', () => {
    const btn = document.getElementById('btnCodeViewsChats');
    const side = document.getElementById('chatSidebar');
    assert.ok(btn);
    assert.ok(side);
    assert.ok(happyDomWindow);

    assert.equal(btn.getAttribute('aria-expanded'), 'true');
    assert.equal(btn.getAttribute('aria-label'), 'Hide chats');

    side.classList.add('collapsed');
    happyDomWindow.dispatchEvent(new happyDomWindow.CustomEvent(CHAT_SIDEBAR_CHANGED_EVENT));

    assert.equal(btn.getAttribute('aria-expanded'), 'false');
    assert.equal(btn.getAttribute('aria-label'), 'Show chats');
  });


  test('clicking Chats closes a Code stage view', async () => {
    const area = document.createElement('main');
    area.id = 'chatArea';
    // Code Overview moved to the Home app; the dev-server screen is a live Code stage view.
    const stage = document.createElement('div');
    stage.id = 'devServerScreenRoot';
    area.appendChild(stage);
    document.body.appendChild(area);

    happyDomWindow!.dispatchEvent(new happyDomWindow!.CustomEvent(CHAT_SIDEBAR_CHANGED_EVENT));

    const btn = document.getElementById('btnCodeViewsChats');
    assert.ok(btn);
    assert.equal(btn.getAttribute('aria-expanded'), 'false');

    btn.click();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(document.getElementById('devServerScreenRoot'), null);
  });
});
