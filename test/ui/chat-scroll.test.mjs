import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Window } from 'happy-dom';

const {
  CHAT_PIN_THRESHOLD_PX,
  bindDesktopChatTranscriptScroll,
  captureChatScrollAnchor,
  isChatAtBottom,
  initChatScroll,
  isChatScrollPinned,
  pinChatScroll,
  restoreChatScrollAnchor,
  scrollChatToBottom,
  scrollChatIfPinned,
} = await import('../../src/ui/chat-scroll.ts');

function makeChatArea({ scrollHeight, clientHeight, scrollTop }) {
  const el = {
    scrollHeight,
    clientHeight,
    scrollTop,
    style: {},
    addEventListener() {},
    classList: { toggle() {} },
  };
  return el;
}

describe('chat-scroll', () => {
  test('isChatAtBottom is true within threshold', () => {
    const atEdge = makeChatArea({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    assert.equal(isChatAtBottom(atEdge), true);

    const within = makeChatArea({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600 - CHAT_PIN_THRESHOLD_PX,
    });
    assert.equal(isChatAtBottom(within), true);

    const detached = makeChatArea({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600 - CHAT_PIN_THRESHOLD_PX - 1,
    });
    assert.equal(isChatAtBottom(detached), false);
  });

  test('isChatAtBottom when content fits viewport', () => {
    const el = makeChatArea({ scrollHeight: 300, clientHeight: 400, scrollTop: 0 });
    assert.equal(isChatAtBottom(el), true);
  });

  test('initChatScroll toggles pin on user scroll and jump re-pins', () => {
    const window = new Window();
    globalThis.document = window.document;
    globalThis.requestAnimationFrame = (cb) => {
      cb();
      return 0;
    };

    const main = document.createElement('div');
    main.id = 'mainColumn';
    document.body.appendChild(main);

    const area = document.createElement('main');
    area.id = 'chatArea';
    area.className = 'chat-area';
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
    main.appendChild(area);

    const chip = document.createElement('button');
    chip.id = 'chatJumpLatest';
    chip.className = 'chat-jump-latest hidden';
    main.appendChild(chip);

    initChatScroll();
    pinChatScroll();
    assert.equal(isChatScrollPinned(), true);

    scrollTop = 0;
    area.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -40 }));
    assert.equal(isChatScrollPinned(), false);
    assert.equal(chip.classList.contains('hidden'), false);

    scrollChatToBottom();
    assert.equal(isChatScrollPinned(), true);
    assert.equal(scrollTop, area.scrollHeight);
    assert.equal(chip.classList.contains('hidden'), true);
  });

  test('jump chip stays hidden in board view chrome', () => {
    const window = new Window();
    globalThis.document = window.document;
    globalThis.requestAnimationFrame = (cb) => {
      cb();
      return 0;
    };

    const main = document.createElement('div');
    main.id = 'mainColumn';
    main.className = 'main-column main-column--board-view';
    document.body.appendChild(main);

    const area = document.createElement('main');
    area.id = 'chatArea';
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
    main.appendChild(area);

    const chip = document.createElement('button');
    chip.id = 'chatJumpLatest';
    chip.className = 'chat-jump-latest';
    main.appendChild(chip);

    initChatScroll();
    area.dispatchEvent(new window.Event('scroll'));
    assert.equal(chip.classList.contains('hidden'), true);
  });

  test('scrollChatIfPinned does not scroll when detached', () => {
    const window = new Window();
    globalThis.document = window.document;
    globalThis.requestAnimationFrame = (cb) => {
      cb();
      return 0;
    };

    const area = document.createElement('main');
    area.id = 'chatArea';
    Object.defineProperty(area, 'scrollHeight', { value: 800, configurable: true });
    Object.defineProperty(area, 'clientHeight', { value: 400, configurable: true });
    let scrollTop = 100;
    Object.defineProperty(area, 'scrollTop', {
      get: () => scrollTop,
      set: (v) => {
        scrollTop = v;
      },
      configurable: true,
    });
    document.body.appendChild(area);

    const chip = document.createElement('button');
    chip.id = 'chatJumpLatest';
    chip.className = 'hidden';
    document.body.appendChild(chip);

    initChatScroll();
    area.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -40 }));
    assert.equal(isChatScrollPinned(), false);

    const before = scrollTop;
    scrollChatIfPinned();
    assert.equal(scrollTop, before);
  });

  test('restoreChatScrollAnchor preserves distance from bottom when detached', () => {
    const window = new Window();
    globalThis.document = window.document;
    globalThis.requestAnimationFrame = (cb) => {
      cb();
      return 0;
    };

    const area = document.createElement('main');
    area.id = 'chatArea';
    Object.defineProperty(area, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(area, 'clientHeight', { value: 400, configurable: true });
    let scrollTop = 120;
    Object.defineProperty(area, 'scrollTop', {
      get: () => scrollTop,
      set: (v) => {
        scrollTop = v;
      },
      configurable: true,
    });
    document.body.appendChild(area);

    const chip = document.createElement('button');
    chip.id = 'chatJumpLatest';
    chip.className = 'hidden';
    document.body.appendChild(chip);

    initChatScroll();
    const anchor = captureChatScrollAnchor();
    assert.equal(anchor?.pinned, false);

    scrollTop = 0;
    Object.defineProperty(area, 'scrollHeight', { value: 2400, configurable: true });
    restoreChatScrollAnchor(anchor);

    const distance = area.scrollHeight - scrollTop - area.clientHeight;
    assert.equal(distance, anchor.distanceFromBottom);
    assert.equal(isChatScrollPinned(), false);
  });

  test('wheel up at the tail stays unpinned after a follow-up scroll in the slack zone', () => {
    const window = new Window();
    globalThis.document = window.document;
    globalThis.requestAnimationFrame = (cb) => {
      cb();
      return 0;
    };

    const area = document.createElement('main');
    area.id = 'chatArea';
    Object.defineProperty(area, 'scrollHeight', { value: 1200, configurable: true });
    Object.defineProperty(area, 'clientHeight', { value: 400, configurable: true });
    let scrollTop = 800;
    Object.defineProperty(area, 'scrollTop', {
      get: () => scrollTop,
      set: (v) => {
        scrollTop = v;
      },
      configurable: true,
    });
    document.body.appendChild(area);

    const chip = document.createElement('button');
    chip.id = 'chatJumpLatest';
    chip.className = 'hidden';
    document.body.appendChild(chip);

    initChatScroll();
    pinChatScroll();
    area.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -40 }));
    assert.equal(isChatScrollPinned(), false);

    area.dispatchEvent(new window.Event('scroll'));
    assert.equal(isChatScrollPinned(), false);
    assert.equal(chip.classList.contains('hidden'), false);
  });

  test('wheel down at the tail re-pins follow', () => {
    const window = new Window();
    globalThis.document = window.document;
    globalThis.requestAnimationFrame = (cb) => {
      cb();
      return 0;
    };

    const area = document.createElement('main');
    area.id = 'chatArea';
    Object.defineProperty(area, 'scrollHeight', { value: 1200, configurable: true });
    Object.defineProperty(area, 'clientHeight', { value: 400, configurable: true });
    let scrollTop = 800;
    Object.defineProperty(area, 'scrollTop', {
      get: () => scrollTop,
      set: (v) => {
        scrollTop = v;
      },
      configurable: true,
    });
    document.body.appendChild(area);

    const chip = document.createElement('button');
    chip.id = 'chatJumpLatest';
    chip.className = 'chat-jump-latest';
    document.body.appendChild(chip);

    initChatScroll();
    area.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -40 }));
    assert.equal(isChatScrollPinned(), false);

    area.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 40 }));
    assert.equal(isChatScrollPinned(), true);
    assert.equal(chip.classList.contains('hidden'), true);
  });

  test('stray scroll while pinned re-glues to the new tail', () => {
    const window = new Window();
    globalThis.document = window.document;
    globalThis.requestAnimationFrame = (cb) => {
      cb();
      return 0;
    };

    const area = document.createElement('main');
    area.id = 'chatArea';
    let scrollHeight = 1200;
    Object.defineProperty(area, 'scrollHeight', {
      get: () => scrollHeight,
      configurable: true,
    });
    Object.defineProperty(area, 'clientHeight', { value: 400, configurable: true });
    let scrollTop = 800;
    Object.defineProperty(area, 'scrollTop', {
      get: () => scrollTop,
      set: (v) => {
        scrollTop = v;
      },
      configurable: true,
    });
    document.body.appendChild(area);

    const chip = document.createElement('button');
    chip.id = 'chatJumpLatest';
    chip.className = 'hidden';
    document.body.appendChild(chip);

    initChatScroll();
    pinChatScroll();
    scrollHeight = 1800;
    area.dispatchEvent(new window.Event('scroll'));
    assert.equal(isChatScrollPinned(), true);
    assert.equal(scrollTop, 1800);
  });

  test('new content does not move the viewport when unpinned', () => {
    const window = new Window();
    globalThis.document = window.document;
    globalThis.requestAnimationFrame = (cb) => {
      cb();
      return 0;
    };

    const area = document.createElement('main');
    area.id = 'chatArea';
    let scrollHeight = 2000;
    Object.defineProperty(area, 'scrollHeight', {
      get: () => scrollHeight,
      configurable: true,
    });
    Object.defineProperty(area, 'clientHeight', { value: 400, configurable: true });
    let scrollTop = 120;
    Object.defineProperty(area, 'scrollTop', {
      get: () => scrollTop,
      set: (v) => {
        scrollTop = v;
      },
      configurable: true,
    });
    document.body.appendChild(area);

    const chip = document.createElement('button');
    chip.id = 'chatJumpLatest';
    chip.className = 'hidden';
    document.body.appendChild(chip);

    initChatScroll();
    area.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -40 }));
    assert.equal(isChatScrollPinned(), false);

    scrollHeight = 2600;
    const before = scrollTop;
    area.dispatchEvent(new window.Event('scroll'));
    scrollChatIfPinned();
    assert.equal(scrollTop, before);
    assert.equal(isChatScrollPinned(), false);
  });
});
