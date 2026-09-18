import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { CHAT_SIDEBAR_CHANGED_EVENT } from '../../src/ui/layout-events.ts';
import { initCodeViewsChatsToggle } from '../../src/ui/code-views-chats-toggle.ts';
import { syncSuperPlanChrome } from '../../src/ui/super-plan-chrome.ts';
import { resetMobileLayoutForTests } from '../../src/ui/mobile-layout.ts';
import { OB_CHAT_AREA_CLASS } from '../../src/ui/orchestrate-page-shell.ts';
import {
  createEmptyChatObject,
  sessionState,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { getOrCreateBoardGroup } from '../../src/state/chat-groups.ts';
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

  test('shows Show chats while Super Plan hides the session list', () => {
    const btn = document.getElementById('btnCodeViewsChats');
    assert.ok(btn);
    assert.ok(happyDomWindow);

    syncSuperPlanChrome(true);

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

  test('clicking Chats closes a stage view even when a board folder is still in board mode', async () => {
    const ws = 'C:\\workspace\\demo';
    const planner = createEmptyChatObject('', ws);
    planner.id = '11111111-1111-1111-1111-111111111111';
    planner.modeId = 'orchestrate';
    setSessionStateForTests({
      version: 5,
      activeId: planner.id,
      sidebarCollapsed: false,
      groups: [],
      chats: [planner],
    });
    const group = getOrCreateBoardGroup(planner);
    group.viewMode = 'board';
    assert.ok(sessionState);
    sessionState.activeBoardGroupId = group.id;

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
    btn.click();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(document.getElementById('devServerScreenRoot'), null);
    assert.equal(group.viewMode, 'board');
  });

  test('shows Show chats while orchestrate board hides the session list', () => {
    const ws = 'C:\\workspace\\demo';
    const planner = createEmptyChatObject('', ws);
    planner.id = '11111111-1111-1111-1111-111111111111';
    planner.modeId = 'orchestrate';
    setSessionStateForTests({
      version: 5,
      activeId: planner.id,
      sidebarCollapsed: false,
      groups: [],
      chats: [planner],
    });
    const group = getOrCreateBoardGroup(planner);
    group.viewMode = 'board';
    assert.ok(sessionState);
    sessionState.activeBoardGroupId = group.id;

    const area = document.createElement('main');
    area.id = 'chatArea';
    area.classList.add(OB_CHAT_AREA_CLASS);
    const page = document.createElement('div');
    page.id = 'orchestrateBoardPage';
    page.className = 'ob-page';
    area.appendChild(page);
    document.body.appendChild(area);

    happyDomWindow!.dispatchEvent(new happyDomWindow!.CustomEvent(CHAT_SIDEBAR_CHANGED_EVENT));

    const btn = document.getElementById('btnCodeViewsChats');
    assert.ok(btn);
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
    assert.equal(btn.getAttribute('aria-label'), 'Show chats');
  });

  test('clicking Chats exits orchestrate board view', async () => {
    const ws = 'C:\\workspace\\demo';
    const planner = createEmptyChatObject('', ws);
    planner.id = '11111111-1111-1111-1111-111111111111';
    planner.modeId = 'orchestrate';
    setSessionStateForTests({
      version: 5,
      activeId: planner.id,
      sidebarCollapsed: true,
      groups: [],
      chats: [planner],
    });
    const group = getOrCreateBoardGroup(planner);
    group.viewMode = 'board';
    assert.ok(sessionState);
    sessionState.activeBoardGroupId = group.id;
    sessionState.sidebarCollapsed = true;

    const main = document.createElement('div');
    main.id = 'mainColumn';
    main.className = 'main-column main-column--board-view';
    const area = document.createElement('main');
    area.id = 'chatArea';
    area.classList.add(OB_CHAT_AREA_CLASS);
    const page = document.createElement('div');
    page.id = 'orchestrateBoardPage';
    page.className = 'ob-page';
    area.appendChild(page);
    main.appendChild(area);
    document.body.appendChild(main);

    const side = document.getElementById('chatSidebar');
    assert.ok(side);
    side.classList.add('collapsed');

    happyDomWindow!.dispatchEvent(new happyDomWindow!.CustomEvent(CHAT_SIDEBAR_CHANGED_EVENT));

    const btn = document.getElementById('btnCodeViewsChats');
    assert.ok(btn);
    assert.equal(btn.getAttribute('aria-label'), 'Show chats');

    btn.click();
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(group.viewMode, 'chat');
    assert.equal(document.getElementById('orchestrateBoardPage'), null);
    // Preference is preserved — CSS hid the list; leaving the board does not expand it.
    assert.equal(side.classList.contains('collapsed'), true);
    assert.equal(sessionState.sidebarCollapsed, true);
  });
});
