/**
 * ask_question strip parks when leaving the owning chat and restores on return.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { launchInstance, resetInstancesForTests } from '../../src/os/instances.ts';
import {
  initOsPageBridge,
  resetOsPageBridgeForTests,
} from '../../src/os/page-bridge.ts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import {
  installHappyDomGlobals,
  teardownHappyDomAsync,
} from '../os/dom-helpers.mts';

/** @type {import('happy-dom').Window | undefined} */
let win: import('happy-dom').Window | undefined;

function setupDom(win: import('happy-dom').Window): void {
  win.document.body.innerHTML = `
    <div id="mainColumn" class="main-column">
      <div id="chatArea" class="chat-area"></div>
      <div id="questionHost" class="question-host" hidden></div>
      <textarea id="msgInput"></textarea>
      <button id="sendBtn"></button>
    </div>
    <div id="desktopComposerRoot" class="mn-os-desktop-composer">
      <div id="desktopQuestionHost" class="question-host" hidden></div>
      <textarea id="desktopInput"></textarea>
      <button id="desktopSendBtn"></button>
    </div>
  `;
}

describe('question-cards-modal chat scope', () => {
  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    win = new Window();
    installHappyDomGlobals(win);
    setupDom(win);
    resetInstancesForTests();
    resetOsPageBridgeForTests();
    initOsPageBridge();

    const chatA = createEmptyChatObject('');
    chatA.id = 'chat-a';
    const chatB = createEmptyChatObject('');
    chatB.id = 'chat-b';
    setSessionStateForTests({
      version: 5,
      activeId: 'chat-a',
      sidebarCollapsed: false,
      chats: [chatA, chatB],
    });
    launchInstance('code');
  });

  afterEach(async () => {
    const { resetQuestionCardsModalForTests } = await import(
      '../../src/ui/question-cards-modal.ts'
    );
    resetQuestionCardsModalForTests();
    const { resetAskQuestionQueueForTests } = await import(
      '../../src/tools/ask-question-queue.ts'
    );
    resetAskQuestionQueueForTests();
    resetInstancesForTests();
    resetOsPageBridgeForTests();
    setSessionStateForTests(null);
    if (win) {
      await teardownHappyDomAsync(win);
      win = undefined;
    }
  });

  test('parks strip when switching away from owning chat', async () => {
    const {
      showQuestionCardsModal,
      syncAskQuestionModalOnChatSwitch,
      isAskQuestionModalOpenForChat,
    } = await import('../../src/ui/question-cards-modal.ts');

    const modalPromise = showQuestionCardsModal(
      {
        questions: [
          {
            id: 'q1',
            prompt: 'Pick one',
            options: [{ id: 'a', label: 'Alpha' }],
          },
        ],
      },
      {},
      { chatId: 'chat-a' },
    );

    const host = document.getElementById('questionHost');
    assert.ok(host?.querySelector('.question-cards-panel'));
    assert.equal(host?.hidden, false);

    syncAskQuestionModalOnChatSwitch('chat-a', 'chat-b');
    assert.equal(host?.hidden, true);
    assert.equal(isAskQuestionModalOpenForChat('chat-a'), true);
    // Parked panel is detached from the shared host; close by chat id.
    const { forceCloseAskQuestionModalForChat } = await import(
      '../../src/ui/question-cards-modal.ts'
    );
    forceCloseAskQuestionModalForChat('chat-a');
    const result = await modalPromise;
    assert.equal(result.status, 'cancelled');
  });

  test('unparks strip when returning to owning chat', async () => {
    const {
      showQuestionCardsModal,
      syncAskQuestionModalOnChatSwitch,
    } = await import('../../src/ui/question-cards-modal.ts');

    const modalPromise = showQuestionCardsModal(
      {
        questions: [
          {
            id: 'q1',
            prompt: 'Pick one',
            options: [{ id: 'a', label: 'Alpha' }],
          },
        ],
      },
      {},
      { chatId: 'chat-a' },
    );

    syncAskQuestionModalOnChatSwitch('chat-a', 'chat-b');
    const host = document.getElementById('questionHost');
    assert.equal(host?.hidden, true);

    syncAskQuestionModalOnChatSwitch('chat-b', 'chat-a');
    assert.equal(host?.hidden, false);
    assert.ok(host?.querySelector('.question-cards-panel'));

    const closeBtn = host?.querySelector('.question-cards-icon-btn') as HTMLButtonElement;
    closeBtn?.click();
    await modalPromise;
  });

  test('unparks strip when code overview overlay closes', async () => {
    const { showQuestionCardsModal } = await import('../../src/ui/question-cards-modal.ts');
    const { notifyAskQuestionDisplayContextChanged } = await import(
      '../../src/chat/ask-question-display.ts'
    );

    const overviewRoot = document.createElement('div');
    overviewRoot.id = 'codeOverviewRoot';
    document.getElementById('chatArea')?.appendChild(overviewRoot);
    document.getElementById('chatArea')?.classList.add('chat-area--code-overview');

    const modalPromise = showQuestionCardsModal(
      {
        questions: [
          {
            id: 'q1',
            prompt: 'Pick one',
            options: [{ id: 'a', label: 'Alpha' }],
          },
        ],
      },
      {},
      { chatId: 'chat-a' },
    );

    const host = document.getElementById('questionHost');
    assert.equal(host?.hidden, true);

    overviewRoot.remove();
    document.getElementById('chatArea')?.classList.remove('chat-area--code-overview');
    notifyAskQuestionDisplayContextChanged();

    assert.equal(host?.hidden, false);
    assert.ok(host?.querySelector('.question-cards-panel'));

    const closeBtn = host?.querySelector('.question-cards-icon-btn') as HTMLButtonElement;
    closeBtn?.click();
    await modalPromise;
  });

  test('switching to another chat shows that chat strip without answering the first', async () => {
    const { enqueueAskQuestion, resetAskQuestionQueueForTests } = await import(
      '../../src/tools/ask-question-queue.ts'
    );
    const { isAskQuestionModalOpenForChat, syncAskQuestionModalOnChatSwitch } = await import(
      '../../src/ui/question-cards-modal.ts'
    );
    const { notifyAskQuestionDisplayContextChanged } = await import(
      '../../src/chat/ask-question-display.ts'
    );
    const { sessionState } = await import('../../src/state/sessions.ts');

    const pA = enqueueAskQuestion(
      {
        questions: [
          {
            id: 'qa1',
            prompt: 'Question from chat A',
            options: [
              { id: 'a', label: 'Alpha' },
              { id: 'b', label: 'Beta' },
            ],
          },
          {
            id: 'qa2',
            prompt: 'Second question from chat A',
            options: [
              { id: 'c', label: 'Charlie' },
              { id: 'd', label: 'Delta' },
            ],
          },
        ],
      },
      {},
      'chat-a',
    );
    const pB = enqueueAskQuestion(
      {
        questions: [
          {
            id: 'qb1',
            prompt: 'Question from chat B',
            options: [
              { id: 'x', label: 'X-ray' },
              { id: 'y', label: 'Yankee' },
            ],
          },
        ],
      },
      {},
      'chat-b',
    );

    const host = document.getElementById('questionHost');
    assert.match(host?.textContent ?? '', /Question from chat A/);
    assert.doesNotMatch(host?.textContent ?? '', /Question from chat B/);
    assert.equal(isAskQuestionModalOpenForChat('chat-a'), true);
    assert.equal(isAskQuestionModalOpenForChat('chat-b'), true);

    if (sessionState) sessionState.activeId = 'chat-b';
    syncAskQuestionModalOnChatSwitch('chat-a', 'chat-b');
    notifyAskQuestionDisplayContextChanged();

    assert.match(host?.textContent ?? '', /Question from chat B/);
    assert.doesNotMatch(host?.textContent ?? '', /Question from chat A/);
    assert.doesNotMatch(host?.textContent ?? '', /Second question from chat A/);

    if (sessionState) sessionState.activeId = 'chat-a';
    syncAskQuestionModalOnChatSwitch('chat-b', 'chat-a');
    notifyAskQuestionDisplayContextChanged();

    assert.match(host?.textContent ?? '', /Question from chat A/);
    assert.doesNotMatch(host?.textContent ?? '', /Question from chat B/);
    assert.match(host?.textContent ?? '', /1 \/ 2/);

    const { forceCloseAskQuestionModalForChat } = await import(
      '../../src/ui/question-cards-modal.ts'
    );
    forceCloseAskQuestionModalForChat('chat-a');
    forceCloseAskQuestionModalForChat('chat-b');
    const [aResult, bResult] = await Promise.all([pA, pB]);
    assert.equal(JSON.parse(aResult).status, 'cancelled');
    assert.equal(JSON.parse(bResult).status, 'cancelled');
    resetAskQuestionQueueForTests();
  });

  test('Escape on the visible strip does not cancel a parked chat', async () => {
    const { showQuestionCardsModal, syncAskQuestionModalOnChatSwitch, isAskQuestionModalOpenForChat } =
      await import('../../src/ui/question-cards-modal.ts');
    const { notifyAskQuestionDisplayContextChanged } = await import(
      '../../src/chat/ask-question-display.ts'
    );
    const { sessionState } = await import('../../src/state/sessions.ts');

    const pA = showQuestionCardsModal(
      {
        questions: [
          {
            id: 'qa1',
            prompt: 'Visible A prompt',
            options: [
              { id: 'a', label: 'Alpha' },
              { id: 'b', label: 'Beta' },
            ],
          },
        ],
      },
      {},
      { chatId: 'chat-a' },
    );
    const pB = showQuestionCardsModal(
      {
        questions: [
          {
            id: 'qb1',
            prompt: 'Parked B prompt',
            options: [
              { id: 'x', label: 'X-ray' },
              { id: 'y', label: 'Yankee' },
            ],
          },
        ],
      },
      {},
      { chatId: 'chat-b' },
    );

    const host = document.getElementById('questionHost');
    const KeyboardEventCtor = (globalThis.window as unknown as {
      KeyboardEvent: typeof KeyboardEvent;
    }).KeyboardEvent;
    const visibleControl = host?.querySelector<HTMLElement>('.question-cards-options input');
    visibleControl?.focus();
    visibleControl?.dispatchEvent(new KeyboardEventCtor('keydown', { key: 'Escape', bubbles: true }));
    const aResult = await pA;
    assert.equal(aResult.status, 'cancelled');
    assert.equal(isAskQuestionModalOpenForChat('chat-b'), true);
    assert.doesNotMatch(host?.textContent ?? '', /Parked B prompt/);

    if (sessionState) sessionState.activeId = 'chat-b';
    syncAskQuestionModalOnChatSwitch('chat-a', 'chat-b');
    notifyAskQuestionDisplayContextChanged();
    assert.match(host?.textContent ?? '', /Parked B prompt/);

    const { forceCloseAskQuestionModalForChat } = await import(
      '../../src/ui/question-cards-modal.ts'
    );
    forceCloseAskQuestionModalForChat('chat-b');
    const bResult = await pB;
    assert.equal(bResult.status, 'cancelled');
  });

  test('stopGeneration for one chat does not close another chat strip', async () => {
    const { showQuestionCardsModal, isAskQuestionModalOpenForChat } = await import(
      '../../src/ui/question-cards-modal.ts'
    );
    const { stopGeneration } = await import('../../src/chat/stop-generation.ts');

    const pA = showQuestionCardsModal(
      {
        questions: [
          {
            id: 'qa1',
            prompt: 'A stop target',
            options: [
              { id: 'a', label: 'Alpha' },
              { id: 'b', label: 'Beta' },
            ],
          },
        ],
      },
      {},
      { chatId: 'chat-a' },
    );
    const pB = showQuestionCardsModal(
      {
        questions: [
          {
            id: 'qb1',
            prompt: 'B should survive stop',
            options: [
              { id: 'x', label: 'X-ray' },
              { id: 'y', label: 'Yankee' },
            ],
          },
        ],
      },
      {},
      { chatId: 'chat-b' },
    );

    stopGeneration('chat-a');
    const aResult = await pA;
    assert.equal(aResult.status, 'cancelled');
    assert.equal(isAskQuestionModalOpenForChat('chat-a'), false);
    assert.equal(isAskQuestionModalOpenForChat('chat-b'), true);

    const { forceCloseAskQuestionModalForChat } = await import(
      '../../src/ui/question-cards-modal.ts'
    );
    forceCloseAskQuestionModalForChat('chat-b');
    const bResult = await pB;
    assert.equal(bResult.status, 'cancelled');
  });
});
