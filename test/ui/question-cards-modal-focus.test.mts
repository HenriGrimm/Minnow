/**
 * ask_question strip scopes keyboard commands to its own focus.
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
    <button id="beforeBtn" type="button">Before</button>
    <div id="mainColumn" class="main-column">
      <div id="questionHost" class="question-host" hidden></div>
      <textarea id="msgInput"></textarea>
      <button id="sendBtn"></button>
    </div>
    <button id="afterBtn" type="button">After</button>
  `;
}

describe('question-cards-modal focus scope', () => {
  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    win = new Window();
    installHappyDomGlobals(win);
    setupDom(win);
    win.globalThis.requestAnimationFrame = (cb: () => void) => {
      cb();
      return 0;
    };
    resetInstancesForTests();
    resetOsPageBridgeForTests();
    initOsPageBridge();
    const chat = createEmptyChatObject('');
    chat.id = 'chat-focus';
    setSessionStateForTests({
      version: 5,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    launchInstance('code');
  });

  afterEach(async () => {
    const { resetQuestionCardsModalForTests } = await import(
      '../../src/ui/question-cards-modal.ts'
    );
    resetQuestionCardsModalForTests();
    resetInstancesForTests();
    resetOsPageBridgeForTests();
    setSessionStateForTests(null);
    if (win) {
      await teardownHappyDomAsync(win);
      win = undefined;
    }
  });

  test('panel is nonmodal dialog with labelled prompt', async () => {
    const { showQuestionCardsModal } = await import('../../src/ui/question-cards-modal.ts');
    const promise = showQuestionCardsModal({
      questions: [
        {
          id: 'q1',
          prompt: 'Pick one',
          options: [
            { id: 'a', label: 'Alpha' },
            { id: 'b', label: 'Beta' },
          ],
        },
      ],
    });

    const panel = win!.document.querySelector('.question-cards-panel');
    assert.ok(panel);
    assert.equal(panel?.getAttribute('role'), 'dialog');
    assert.equal(panel?.getAttribute('aria-modal'), 'false');
    assert.ok(panel?.getAttribute('aria-labelledby'));

    const { forceCloseAskQuestionModal } = await import('../../src/ui/question-cards-modal.ts');
    forceCloseAskQuestionModal();
    await promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test('Tab can leave panel and close restores prior focus', async () => {
    const beforeBtn = win!.document.getElementById('beforeBtn') as HTMLButtonElement;
    beforeBtn.focus();
    assert.equal(win!.document.activeElement, beforeBtn);

    const { showQuestionCardsModal } = await import('../../src/ui/question-cards-modal.ts');
    const promise = showQuestionCardsModal({
      questions: [
        {
          id: 'q1',
          prompt: 'Pick one',
          options: [
            { id: 'a', label: 'Alpha' },
            { id: 'b', label: 'Beta' },
          ],
        },
      ],
    });

    const panel = win!.document.querySelector('.question-cards-panel') as HTMLElement;
    const closeBtn = panel.querySelector(
      '.question-cards-icon-btn',
    ) as HTMLButtonElement;
    assert.ok(closeBtn);

    closeBtn.focus();
    assert.equal(win!.document.activeElement, closeBtn);

    const tabEvent = new win!.KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    panel.dispatchEvent(tabEvent);
    assert.equal(tabEvent.defaultPrevented, false);

    closeBtn.click();
    const result = await promise;
    assert.equal(result.status, 'cancelled');
    assert.equal(win!.document.activeElement, beforeBtn);
  });

  test('outside focus stays outside and its keyboard commands do not cancel the question', async () => {
    const { showQuestionCardsModal } = await import('../../src/ui/question-cards-modal.ts');
    const promise = showQuestionCardsModal({
      questions: [
        {
          id: 'q1',
          prompt: 'Pick one',
          options: [{ id: 'a', label: 'Alpha' }],
        },
      ],
    });

    const afterBtn = win!.document.getElementById('afterBtn') as HTMLButtonElement;
    afterBtn.focus();

    const panel = win!.document.querySelector('.question-cards-panel') as HTMLElement;
    assert.equal(win!.document.activeElement, afterBtn);
    for (const key of ['ArrowLeft', 'ArrowRight', 'Escape', 'Tab']) {
      const event = new win!.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      afterBtn.dispatchEvent(event);
      assert.equal(event.defaultPrevented, false, key);
      assert.ok(panel.isConnected, key);
      assert.equal(win!.document.activeElement, afterBtn, key);
    }
    const option = panel.querySelector('.question-cards-options input') as HTMLInputElement;
    option.focus();
    const escape = new win!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    option.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal((await promise).status, 'cancelled');

    const { forceCloseAskQuestionModal } = await import('../../src/ui/question-cards-modal.ts');
    forceCloseAskQuestionModal();
    await promise;
  });
  test('background cancellation preserves focus outside the question', async () => {
    const { showQuestionCardsModal, forceCloseAskQuestionModal } = await import('../../src/ui/question-cards-modal.ts');
    const promise = showQuestionCardsModal({ questions: [{ id: 'q1', prompt: 'Pick one', options: [{ id: 'a', label: 'Alpha' }] }] });
    const afterBtn = win!.document.getElementById('afterBtn') as HTMLButtonElement;
    afterBtn.focus();
    forceCloseAskQuestionModal();
    assert.equal((await promise).status, 'cancelled');
    assert.equal(win!.document.activeElement, afterBtn);
  });

});
