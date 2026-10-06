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
const { syncComposerFromStreamingState } = await import('../../src/ui/composer-send.ts');

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
  test('enables mode buttons when the active chat finishes without navigating away', () => {
    const modeSelector = setupModeSelectorDom();
    const chat = createEmptyChatObject('');
    chat.id = REGULAR_CHAT_ID;
    chat.modeId = 'general';
    setSessionStateForTests({
      version: 2,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    initModeSelector();
    const buildButton = modeSelector.querySelector<HTMLButtonElement>('[data-mode-id="build"]');
    assert.ok(buildButton);

    setStreaming(true, chat.id);
    syncComposerFromStreamingState();
    assert.equal(buildButton.disabled, true);

    setStreaming(false, chat.id);
    syncComposerFromStreamingState();
    assert.equal(buildButton.disabled, false);
    buildButton.click();
    assert.equal(chat.modeId, 'build');
  });

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

  test('hides mode selection for the board planner and restores it for regular chats', () => {
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

    assert.equal(modeSelector.hidden, false);
  });

  test('compact composer uses a mode dropdown instead of icon-only segments', () => {
    const modeSelector = setupModeSelectorDom({ hubComposer: true });
    const chat = createEmptyChatObject('');
    chat.id = REGULAR_CHAT_ID;
    chat.modeId = 'build';
    setSessionStateForTests({
      version: 2,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    initModeSelector();
    document.getElementById('composerControls')?.classList.add('composer-controls--compact');
    syncModeSelectorFromActiveChat();

    const dropdown = document.getElementById('modeSelectorDropdown');
    assert.ok(dropdown);
    assert.equal(dropdown?.hidden, false);
    assert.match(dropdown?.textContent ?? '', /Build/);
    assert.equal(modeSelector.classList.contains('mode-segmented--compact'), false);
    assert.ok(modeSelector.querySelector('.mode-segment__label'));
  });

  test('Plan is a plain segment: no caret, no hidden Super Plan menu', () => {
    const modeSelector = setupModeSelectorDom();
    const chat = createEmptyChatObject('');
    chat.id = REGULAR_CHAT_ID;
    chat.modeId = 'plan';
    setSessionStateForTests({
      version: 2,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    initModeSelector();

    assert.equal(modeSelector.querySelector('.mode-segment__caret'), null);
    assert.equal(modeSelector.querySelector('.mode-submenu'), null);
    const plan = modeSelector.querySelector('[data-mode-id="plan"]');
    assert.equal(plan?.querySelector('.mode-segment__label')?.textContent, 'Plan');
    assert.equal(plan?.getAttribute('aria-checked'), 'true');
  });

  test('a Super Plan chat still lights the Plan segment', () => {
    const modeSelector = setupModeSelectorDom();
    const chat = createEmptyChatObject('');
    chat.id = REGULAR_CHAT_ID;
    chat.modeId = 'super-plan';
    setSessionStateForTests({
      version: 2,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    initModeSelector();

    assert.equal(
      modeSelector.querySelector('[data-mode-id="plan"]')?.getAttribute('aria-checked'),
      'true',
    );
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
