/**
 * Hub DOM lifecycle — composer must survive teardown/remount (mode changes).
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { setSessionStateForTests, createEmptyChatObject } = await import(
  '../../src/state/sessions.ts'
);
const { renderHub, teardownHub, isHubMounted, HUB_ROOT_ID } = await import(
  '../../src/ui/hub.ts'
);

let domWindow: Window | null = null;

function setupDom(): void {
  const window = new Window();
  domWindow = window;
  globalThis.window = window as unknown as Window & typeof globalThis.window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);

  document.body.innerHTML = `
    <div id="mainColumn">
      <div id="chatArea"></div>
      <div class="input-bar">
        <textarea id="msgInput"></textarea>
        <div id="modeSelector"></div>
      </div>
    </div>
  `;
}

afterEach(() => {
  teardownHub();
  setSessionStateForTests(null);
  domWindow?.close();
  domWindow = null;
});

describe('hub teardown', () => {
  test('remounting hub keeps .input-bar in the document', () => {
    setupDom();
    const chat = createEmptyChatObject('test-model');
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      chats: [chat],
      sidebarCollapsed: false,
    });

    renderHub(chat);
    assert.equal(isHubMounted(), true);
    assert.ok(document.querySelector('.input-bar--hub'));

    renderHub(chat);
    assert.equal(isHubMounted(), true);
    assert.ok(document.getElementById('msgInput'), 'composer textarea survives remount');
    assert.ok(
      document.getElementById(HUB_ROOT_ID)?.querySelector('.hub-composer-slot .input-bar'),
      'composer stays inside hub slot after remount',
    );
  });

  test('hub landing omits mode-intent chips', () => {
    setupDom();
    const chat = createEmptyChatObject('test-model');
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      chats: [chat],
      sidebarCollapsed: false,
    });

    renderHub(chat);
    assert.equal(document.querySelector('.hub-intents'), null);
    assert.equal(document.querySelector('.hub-intent'), null);
    assert.ok(document.querySelector('.hub-composer-slot'), 'composer slot remains');
    assert.ok(document.querySelector('.hub-strip'), 'metrics strip remains');
    const inner = document.querySelector('.hub-inner')!;
    const actions = inner.querySelector('.code-readiness-actions')!;
    assert.deepEqual(Array.from(actions.querySelectorAll('button'), (button) => button.textContent),
      ['Browse files', 'Open terminal']);
    assert.ok(Array.from(inner.children).indexOf(actions) <
      Array.from(inner.children).indexOf(inner.querySelector('.hub-status')!),
    'manual workspace actions precede model status and metrics');
    assert.ok(document.querySelector('.hub-recent-row'), 'recent threads remain');
  });

  test('teardownHub before chatArea.replaceChildren keeps composer in the document', () => {
    setupDom();
    const chat = createEmptyChatObject('test-model');
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      chats: [chat],
      sidebarCollapsed: false,
    });

    renderHub(chat);
    assert.ok(document.querySelector('.hub-composer-slot .input-bar'));

    teardownHub();
    document.getElementById('chatArea')!.replaceChildren();

    assert.ok(document.getElementById('msgInput'), 'composer survives when hub is torn down first');
  });
});
