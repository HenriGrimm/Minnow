import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const appState = await import('../../src/app-state.ts');
const { setSessionStateForTests, createEmptyChatObject } = await import(
  '../../src/state/sessions.ts'
);
const {
  setComposerStreamingMode,
  shouldAllowComposerPrimaryAction,
  syncComposerFromStreamingState,
} = await import('../../src/ui/composer-send.ts');

const FIXED_CHAT_ID = '11111111-1111-1111-1111-111111111111';

function setupSendButton() {
  const window = new Window();
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;

  const btn = document.createElement('button');
  btn.id = 'sendBtn';
  btn.type = 'button';
  btn.innerHTML = `
    <span id="sendIcon"></span>
    <span id="sendStopIcon" class="hidden"></span>
    <span id="sendSpinner" class="hidden"></span>
  `;
  document.body.appendChild(btn);

  const input = document.createElement('textarea');
  input.id = 'msgInput';
  document.body.appendChild(input);

  return btn;
}

function setupDesktopSendButton() {
  const window = new Window();
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;

  const btn = document.createElement('button');
  btn.id = 'desktopSendBtn';
  btn.type = 'button';
  document.body.appendChild(btn);

  const input = document.createElement('textarea');
  input.id = 'desktopInput';
  document.body.appendChild(input);

  return { btn, input };
}

describe('shouldAllowComposerPrimaryAction', () => {
  afterEach(() => {
    appState.setStreaming(false);
    setSessionStateForTests(null);
  });

  test('empty input is blocked while idle', () => {
    setSessionStateForTests({
      version: 3,
      activeId: FIXED_CHAT_ID,
      sidebarCollapsed: false,
      chats: [createEmptyChatObject(FIXED_CHAT_ID)],
    });
    assert.equal(shouldAllowComposerPrimaryAction(''), false);
    assert.equal(shouldAllowComposerPrimaryAction('   '), false);
  });

  test('empty input is allowed while streaming (stop)', () => {
    const chat = createEmptyChatObject(FIXED_CHAT_ID);
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    appState.setStreaming(true, chat.id);
    assert.equal(shouldAllowComposerPrimaryAction(''), true);
  });
});

describe('setComposerStreamingMode', () => {
  afterEach(() => {
    appState.setStreaming(false);
    setSessionStateForTests(null);
    if (globalThis.document) {
    }
  });

  test('streaming mode shows stop affordance and keeps button enabled', () => {
    const btn = setupSendButton();
    setComposerStreamingMode('streaming');

    assert.equal(btn.disabled, false);
    assert.equal(btn.dataset.mode, 'stop');
    assert.equal(btn.getAttribute('aria-label'), 'Stop generating');
    assert.ok(btn.classList.contains('send-btn--stop'));
    assert.ok(!document.getElementById('sendStopIcon').classList.contains('hidden'));
    assert.ok(document.getElementById('sendIcon').classList.contains('hidden'));
    assert.equal((document.getElementById('msgInput')).disabled, false);
  });

  test('idle mode restores send affordance', () => {
    const btn = setupSendButton();
    setComposerStreamingMode('streaming');
    setComposerStreamingMode('idle');

    assert.equal(btn.disabled, false);
    assert.equal(btn.dataset.mode, 'send');
    assert.equal(btn.getAttribute('aria-label'), 'Send message');
    assert.ok(!btn.classList.contains('send-btn--stop'));
    assert.ok(!document.getElementById('sendIcon').classList.contains('hidden'));
    assert.ok(document.getElementById('sendStopIcon').classList.contains('hidden'));
  });

  test('syncComposerFromStreamingState restores send mode after stream end', () => {
    const btn = setupSendButton();
    const chat = createEmptyChatObject(FIXED_CHAT_ID);
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    appState.setStreaming(true, chat.id);
    syncComposerFromStreamingState();
    assert.equal(btn.dataset.mode, 'stop');
    assert.equal(document.getElementById('msgInput').placeholder, 'Steer the run, or queue a follow-up…');

    appState.setStreaming(false, chat.id);
    syncComposerFromStreamingState();
    assert.equal(btn.dataset.mode, 'send');
    assert.notEqual(document.getElementById('msgInput').placeholder, 'Steer the run, or queue a follow-up…');
  });

});
