/**
 * MIN-793 #2 — a long transcript must not rebuild as one unbroken main-thread task.
 * The switch renders the tail; older rows load in requested pages, prepended above.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import {
  installHappyDomGlobals,
  teardownHappyDomAsync,
} from '../os/dom-helpers.mts';

const { setSessionStateForTests, createEmptyChatObject } = await import(
  '../../src/state/sessions.ts'
);
const { resetInstancesForTests } = await import('../../src/os/instances.ts');
const { renderChatFromHistory, renderEmbeddedChatTranscript, cancelChatHistoryBackfill } = await import(
  '../../src/ui/messages.ts'
);
const { initChatScroll } = await import('../../src/ui/chat-scroll.ts');

/** @type {import('happy-dom').Window | undefined} */
let domWindow;

/** Mount a transcript for a chat with `count` user messages. */
function setup(count, chatId) {
  domWindow = new Window();
  installHappyDomGlobals(domWindow);
  DOMPurify.sanitize = DOMPurify(domWindow).sanitize;
  resetInstancesForTests();

  const chatArea = document.createElement('div');
  chatArea.id = 'chatArea';
  document.body.appendChild(chatArea);
  Object.defineProperties(chatArea, {
    clientHeight: { value: 600, configurable: true },
    scrollHeight: { get: () => bubbleTexts(chatArea).length * 100, configurable: true },
  });
  initChatScroll();

  const chat = createEmptyChatObject('');
  chat.id = chatId;
  chat.history = Array.from({ length: count }, (_, i) => ({
    role: 'user',
    content: `message ${i}`,
  }));
  setSessionStateForTests({
    version: 2,
    activeId: chat.id,
    sidebarCollapsed: false,
    chats: [chat],
  });
  return { chatArea, chat };
}

/** Let queued idle/rAF chunks drain. */
async function drain() {
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

function bubbleTexts(chatArea) {
  return [...chatArea.querySelectorAll('.msg.user .msg-bubble')].map((el) => el.textContent);
}

function scrollEarlier(root, top = 800) {
  root.scrollTop = top;
  root.dispatchEvent(new domWindow.WheelEvent('wheel', { deltaY: -40 }));
}

describe('chunked transcript rebuild', { concurrency: false }, () => {
  afterEach(async () => {
    cancelChatHistoryBackfill();
    setSessionStateForTests(null);
    resetInstancesForTests();
    if (domWindow) {
      await teardownHappyDomAsync(domWindow);
      domWindow = undefined;
    }
  });

  test('the switch keeps older rows unmounted until the reader requests them', async () => {
    const { chatArea, chat } = setup(80, 'chunked-chat');

    renderChatFromHistory(chat);

    const immediate = bubbleTexts(chatArea);
    assert.ok(
      immediate.length > 0 && immediate.length < 80,
      `switch must not render all 80 rows synchronously (got ${immediate.length})`,
    );
    assert.equal(immediate.at(-1), 'message 79', 'the newest message is what the user looks at');
    assert.equal(chatArea.querySelector('.chat-history-more'), null, 'history has no load button');

    await drain();
    assert.equal(bubbleTexts(chatArea).length, immediate.length, 'idle time must not eagerly mount history');
    for (let page = 0; Number(chatArea.dataset.historyStart) > 0 && page < 10; page++) {
      scrollEarlier(chatArea);
      await drain();
    }

    const full = bubbleTexts(chatArea);
    assert.equal(full.length, 80);
    assert.equal(full[0], 'message 0', 'older rows land above, in history order');
    assert.equal(full.at(-1), 'message 79');
  });

  test('a short history still renders in one pass', () => {
    const { chatArea, chat } = setup(5, 'short-chat');

    renderChatFromHistory(chat);

    assert.equal(bubbleTexts(chatArea).length, 5);
  });

  test('a same-chat repaint retains earlier pages the reader has already loaded', async () => {
    const { chatArea, chat } = setup(100, 'retained-pages');
    renderChatFromHistory(chat);
    scrollEarlier(chatArea);
    await drain();
    assert.equal(bubbleTexts(chatArea)[0], 'message 40');
    chat.history.push({ role: 'user', content: 'new message' });
    renderChatFromHistory(chat);
    assert.equal(bubbleTexts(chatArea)[0], 'message 40');
    assert.equal(bubbleTexts(chatArea).at(-1), 'new message');
    assert.equal(bubbleTexts(chatArea).length, 61);
  });

  test('scrolling up preloads off-screen history without changing existing row identity', async () => {
    const { chatArea, chat } = setup(100, 'paged-chat');
    renderChatFromHistory(chat);
    const last = chatArea.querySelector('.msg:last-child');
    scrollEarlier(chatArea);
    await drain();
    assert.equal(bubbleTexts(chatArea).length, 60);
    assert.equal(chatArea.querySelector('.msg:last-child'), last);
    assert.equal(bubbleTexts(chatArea)[0], 'message 40');
    assert.equal(chatArea.querySelector('.msg').dataset.historyIndex, '40');
  });

  test('scrolling toward older messages loads one page and preserves the scroll anchor', async () => {
    const { chatArea, chat } = setup(100, 'scroll-page');
    Object.defineProperty(chatArea, 'clientHeight', { value: 100 });
    Object.defineProperty(chatArea, 'scrollHeight', { get: () => bubbleTexts(chatArea).length * 20 });
    chatArea.scrollTop = 25;
    renderChatFromHistory(chat);
    await drain();
    const initiallyLoaded = bubbleTexts(chatArea).length;
    chatArea.scrollTop = 25;
    chatArea.style.scrollBehavior = 'smooth';
    let top = 25;
    let anchorBehavior;
    const scrollBy = chatArea.scrollBy.bind(chatArea);
    chatArea.scrollBy = options => { anchorBehavior = options.behavior; scrollBy(options); };
    Object.defineProperty(chatArea, 'scrollTop', {
      get: () => top,
      set: value => { top = value; },
    });
    chatArea.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -20 }));
    await drain();
    assert.equal(bubbleTexts(chatArea).length, initiallyLoaded + 30);
    assert.equal(chatArea.scrollTop, 625, 'the same row remains at the same screen position');
    assert.equal(anchorBehavior, 'instant', 'anchor correction must not animate on smooth-scroll hosts');
    assert.equal(chatArea.style.scrollBehavior, 'smooth', 'the host scroll preference is restored');
    await drain();
    assert.equal(bubbleTexts(chatArea).length, initiallyLoaded + 30, 'stop loading once the off-screen buffer is full');
  });

  for (const surface of ['main', 'embedded']) {
    test(`${surface} paging settles compact work before restoring the scroll position`, async () => {
      const { chatArea, chat } = setup(0, `compact-page-${surface}`);
      Object.defineProperty(chatArea, 'clientHeight', { value: 100 });
      chat.history = Array.from({ length: 8 }, (_, turn) => [
        { role: 'user', content: `Question ${turn}` },
        ...Array.from({ length: 20 }, (_, step) => {
          const id = `${turn}-${step}`;
          return [
            { role: 'assistant', content: 'Checking the file.', tool_calls: [
              { id, type: 'function', function: { name: 'read_file', arguments: '{"path":"src/chat.ts"}' } },
            ] },
            { role: 'tool', tool_call_id: id, content: 'File contents' },
          ];
        }).flat(),
        { role: 'assistant', content: `Final answer ${turn}` },
      ]).flat();
      const mount = surface === 'main' ? chatArea : chatArea.appendChild(document.createElement('div'));
      // Model layout height so a deferred compact-view collapse changes scrollHeight.
      Object.defineProperty(chatArea, 'scrollHeight', { get: () =>
        [...mount.children].filter(row => !row.classList.contains('chat-work-hidden')).length * 100,
      });
      let dispose;
      try {
        if (surface === 'main') renderChatFromHistory(chat);
        else ({ dispose } = renderEmbeddedChatTranscript(chat, mount, new Set()));
        await drain();
        chatArea.scrollTop = 500;
        const height = chatArea.scrollHeight;
        const start = mount.dataset.historyStart;
        scrollEarlier(chatArea, 500);
        await drain();

        assert.ok(Number(mount.dataset.historyStart) < Number(start), 'load earlier pages beyond the initial buffer');
        assert.ok(mount.querySelectorAll('.tool-call-msg.chat-work-hidden').length > 0);
        assert.equal(chatArea.scrollTop, 500 + chatArea.scrollHeight - height,
          'the anchor uses the settled height, with no second-frame collapse jump');
      } finally {
        dispose?.();
      }
    });
  }

  test('switching away abandons the previous chat backfill', async () => {
    const { chatArea, chat } = setup(80, 'abandoned-chat');
    renderChatFromHistory(chat);
    const partial = bubbleTexts(chatArea).length;
    scrollEarlier(chatArea);

    // A second paint owns the transcript now; the first chat's chunks must not land in it.
    const other = createEmptyChatObject('');
    other.id = 'other-chat';
    other.history = [{ role: 'user', content: 'only message' }];
    setSessionStateForTests({
      version: 2,
      activeId: other.id,
      sidebarCollapsed: false,
      chats: [chat, other],
    });
    renderChatFromHistory(other);

    await drain();

    assert.ok(partial < 80);
    assert.deepEqual(bubbleTexts(chatArea), ['only message']);
  });
});
