import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';

const BOARD_CHAT_ID = '11111111-1111-1111-1111-111111111111';
const REGULAR_CHAT_ID = '22222222-2222-2222-2222-222222222222';
const BOARD_GROUP_ID = 'grp_11111111-1111-1111-1111-111111111111';
const BOARD_TASK_ID = 'task-1';

const { createEmptyChatObject, setSessionStateForTests } = await import(
  '../../src/state/sessions.ts'
);
const {
  disposeModeSelectorForTests,
  initModeSelector,
  setChatMode,
  syncModeSelectorFromActiveChat,
} = await import('../../src/ui/mode-selector.ts');
const { setStreaming } = await import('../../src/app-state.ts');

let windowInstance: Window | null = null;

function setupModeSelectorDom(options?: { hubComposer?: boolean }): HTMLElement {
  windowInstance = new Window();
  installHappyDomGlobals(windowInstance);

  const composerControls = document.createElement('div');
  composerControls.id = 'composerControls';
  const modeSelector = document.createElement('div');
  modeSelector.id = 'modeSelector';
  modeSelector.className = 'mode-segmented';
  composerControls.appendChild(modeSelector);

  if (options?.hubComposer) {
    const bar = document.createElement('div');
    bar.className = 'input-bar input-bar--hub';
    bar.appendChild(composerControls);
    document.body.appendChild(bar);
  } else {
    document.body.appendChild(composerControls);
  }

  return modeSelector;
}

afterEach(() => {
  setStreaming(false);
  disposeModeSelectorForTests();
  setSessionStateForTests(null);
  windowInstance?.close();
  windowInstance = null;
});

describe('mode selector for orchestrator board chats', () => {
  test('hides mode selection and preserves a board task chat role', () => {
    const modeSelector = setupModeSelectorDom();
    const chat = createEmptyChatObject('');
    chat.id = BOARD_CHAT_ID;
    chat.modeId = 'build';
    chat.workAgentAuto = true;
    chat.workAgentId = 'tester';
    chat.boardGroupId = BOARD_GROUP_ID;
    chat.boardTaskId = BOARD_TASK_ID;
    setSessionStateForTests({
      version: 2,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    initModeSelector();
    const result = setChatMode('plan');

    assert.equal(modeSelector.hidden, true);
    assert.deepEqual(result, {
      ok: false,
      error: 'Board chats keep the role assigned by the orchestrator',
    });
    assert.equal(chat.modeId, 'build');
    assert.equal(chat.workAgentId, 'tester');
  });

  test('switching from a board planner to a regular chat keeps modes hidden', () => {
    const modeSelector = setupModeSelectorDom();
    const boardPlanner = createEmptyChatObject('');
    boardPlanner.id = BOARD_CHAT_ID;
    boardPlanner.modeId = 'orchestrate';
    boardPlanner.boardGroupId = BOARD_GROUP_ID;
    const regularChat = createEmptyChatObject('');
    regularChat.id = REGULAR_CHAT_ID;
    regularChat.modeId = 'general';
    setSessionStateForTests({
      version: 2,
      activeId: boardPlanner.id,
      sidebarCollapsed: false,
      chats: [boardPlanner, regularChat],
    });

    initModeSelector();
    assert.equal(modeSelector.hidden, true);

    setSessionStateForTests({
      version: 2,
      activeId: regularChat.id,
      sidebarCollapsed: false,
      chats: [boardPlanner, regularChat],
    });
    syncModeSelectorFromActiveChat();

    assert.equal(modeSelector.hidden, true);
    assert.equal(modeSelector.querySelector('[data-mode-id]'), null);
  });

  test('keeps the hidden selector out of layout despite its inline-flex styling', () => {
    const modeSelectorCss = readFileSync(
      new URL('../../src/styles/mode-selector.css', import.meta.url),
      'utf8',
    );

    assert.match(
      modeSelectorCss,
      /#modeSelector\[hidden\]\s*\{\s*display:\s*none;\s*\}/,
    );
  });
});
