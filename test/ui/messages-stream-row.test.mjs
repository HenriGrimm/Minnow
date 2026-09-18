import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { setSessionStateForTests, createEmptyChatObject } = await import(
  '../../src/state/sessions.ts'
);
const {
  appendStreamingAssistantRow,
  revealAssistantProseBubble,
} = await import('../../src/ui/messages.ts');
const {
  initChatScroll,
  isChatScrollPinned,
  scrollChatToBottom,
} = await import('../../src/ui/chat-scroll.ts');

function setupChatDom() {
  const window = new Window();
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  document.body.innerHTML =
    '<main id="chatArea"><div id="emptyState">Empty</div></main>' +
    '<button id="chatJumpLatest" class="chat-jump-latest hidden"></button>';
  globalThis.requestAnimationFrame = (cb) => {
    cb();
    return 0;
  };
  initChatScroll();
  const chat = createEmptyChatObject('');
  chat.id = 'chat-stream-row';
  setSessionStateForTests({
    version: 2,
    activeId: chat.id,
    sidebarCollapsed: false,
    chats: [chat],
  });
  return window;
}

describe('messages stream row', { concurrency: false }, () => {
  afterEach(() => {
    setSessionStateForTests(null);
  });

test('appendStreamingAssistantRow inserts stream-status before awaiting bubble', () => {
  setupChatDom();
  const { wrap, bubble, streamStatus } = appendStreamingAssistantRow();

  const status = wrap.querySelector('.stream-status');
  assert.ok(status);
  assert.equal(status?.nextElementSibling, bubble);
  assert.ok(wrap.classList.contains('msg--awaiting-prose'));
  assert.ok(bubble.classList.contains('msg-bubble--awaiting'));

  streamStatus.dispose();
});

test('appendStreamingAssistantRow does not force scroll when user scrolled up', () => {
  const win = setupChatDom();
  const area = document.getElementById('chatArea');
  Object.defineProperty(area, 'scrollHeight', { value: 1200, configurable: true });
  Object.defineProperty(area, 'clientHeight', { value: 400, configurable: true });
  let scrollTop = 0;
  Object.defineProperty(area, 'scrollTop', {
    get: () => scrollTop,
    set: (v) => {
      scrollTop = v;
    },
    configurable: true,
  });

  scrollChatToBottom();
  assert.equal(isChatScrollPinned(), true);

  // Only a user gesture unpins; a bare scroll event is treated as layout.
  area.dispatchEvent(new win.WheelEvent('wheel', { deltaY: -120 }));
  scrollTop = 0;
  area.dispatchEvent(new win.Event('scroll'));
  assert.equal(isChatScrollPinned(), false);

  const before = scrollTop;
  const { streamStatus } = appendStreamingAssistantRow();
  assert.equal(scrollTop, before, 'new stream shell must not snap scroll when detached');
  assert.equal(isChatScrollPinned(), false);

  streamStatus.dispose();
});

test('appendStreamingAssistantRow follows tail when pinned near bottom', () => {
  setupChatDom();
  const area = document.getElementById('chatArea');
  Object.defineProperty(area, 'scrollHeight', { value: 1200, configurable: true });
  Object.defineProperty(area, 'clientHeight', { value: 400, configurable: true });
  let scrollTop = 0;
  Object.defineProperty(area, 'scrollTop', {
    get: () => scrollTop,
    set: (v) => {
      scrollTop = v;
    },
    configurable: true,
  });

  scrollChatToBottom();
  const { streamStatus } = appendStreamingAssistantRow();
  assert.equal(scrollTop, area.scrollHeight);

  streamStatus.dispose();
});

test('revealAssistantProseBubble removes awaiting state and hides status', () => {
  setupChatDom();
  const { wrap, bubble, streamStatus } = appendStreamingAssistantRow();

  revealAssistantProseBubble(wrap, bubble, streamStatus);

  assert.ok(!wrap.classList.contains('msg--awaiting-prose'));
  assert.ok(!bubble.classList.contains('msg-bubble--awaiting'));
  const status = wrap.querySelector('.stream-status');
  assert.ok(status?.classList.contains('hidden'));
  assert.equal(status?.getAttribute('aria-busy'), 'false');

  streamStatus.dispose();
});

test('appendStreamingAssistantRow drops a revealed live row that still has a caret', () => {
  setupChatDom();
  const first = appendStreamingAssistantRow();
  revealAssistantProseBubble(first.wrap, first.bubble, first.streamStatus);
  assert.ok(first.wrap.querySelector('.cursor--prose'));
  assert.ok(!first.wrap.classList.contains('msg--awaiting-prose'));

  const second = appendStreamingAssistantRow();

  const area = document.getElementById('chatArea');
  assert.equal(area?.querySelectorAll('.msg.assistant').length, 1);
  assert.equal(area?.querySelectorAll('.cursor--prose').length, 1);
  assert.equal(area?.querySelector('.msg.assistant'), second.wrap);
  assert.equal(first.wrap.isConnected, false);

  second.streamStatus.dispose();
});

test('appendStreamingAssistantRow keeps a settled assistant message without a caret', () => {
  setupChatDom();
  const area = document.getElementById('chatArea');
  const settled = document.createElement('div');
  settled.className = 'msg assistant';
  settled.innerHTML = '<div class="msg-label">Assistant</div><div class="msg-bubble">Done.</div>';
  area.appendChild(settled);

  const { wrap, streamStatus } = appendStreamingAssistantRow();

  assert.equal(area?.querySelectorAll('.msg.assistant').length, 2);
  assert.ok(settled.isConnected);
  assert.equal(wrap.classList.contains('msg--awaiting-prose'), true);

  streamStatus.dispose();
});
});
