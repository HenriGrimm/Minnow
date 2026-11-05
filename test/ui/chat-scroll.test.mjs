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
  observeChatScrollLayout,
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
  test('an up/down reversal during a follow write reaches the tail without Jump to latest', async () => {
    const window = new Window();
    globalThis.document = window.document;
    const frames = [];
    globalThis.requestAnimationFrame = cb => { frames.push(cb); return frames.length; };
    globalThis.cancelAnimationFrame = () => {};
    const area = document.createElement('main');
    area.id = 'chatArea';
    const chip = document.createElement('button');
    chip.id = 'chatJumpLatest';
    document.body.append(area, chip);
    let height = 1200;
    let top = 800;
    Object.defineProperties(area, {
      scrollHeight: { get: () => height }, clientHeight: { value: 400 },
      scrollTop: { get: () => top, set: value => { top = Math.min(value, height - 400); } },
    });
    try {
      initChatScroll();
      scrollChatToBottom();
      // No frame release yet: actual user input must win over an earlier automatic write.
      area.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -100 }));
      top = 700;
      area.dispatchEvent(new window.Event('scroll'));
      assert.equal(isChatScrollPinned(), false);
      area.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 100 }));
      top = 800;
      area.dispatchEvent(new window.Event('scroll'));
      assert.equal(isChatScrollPinned(), true, 'reaching the bottom must reattach immediately');
      assert.equal(chip.classList.contains('hidden'), true);
      height = 1500;
      scrollChatIfPinned();
      assert.equal(top, 1100, 'late reply layout must remain reachable and followed');
    } finally {
      while (frames.length) frames.shift()();
      await window.happyDOM.close();
    }
  });

  for (const gesture of ['small wheel', 'native scrollbar', 'scrollbar during follow', 'downward correction']) {
    test(`${gesture} does not snap an up-thread reader back to the bottom`, async () => {
      const window = new Window();
      globalThis.document = window.document;
      let frames = [];
      globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
      globalThis.cancelAnimationFrame = () => {};
      const flushFrames = () => {
        while (frames.length) {
          const pending = frames;
          frames = [];
          for (const cb of pending) cb();
        }
      };
      const area = document.createElement('main');
      area.id = 'chatArea';
      const chip = document.createElement('button');
      chip.id = 'chatJumpLatest';
      document.body.append(area, chip);
      let height = 1200;
      let top = 800;
      Object.defineProperties(area, {
        scrollHeight: { get: () => height }, clientHeight: { value: 400 },
        scrollTop: { get: () => top, set: value => { top = Math.min(value, height - 400); } },
      });
      try {
        initChatScroll();
        scrollChatToBottom();
        if (gesture !== 'scrollbar during follow') flushFrames();
        if (gesture === 'small wheel') {
          area.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -0.5 }));
          assert.equal(isChatScrollPinned(), false, 'release before the next stream tick');
          top = 799.5;
        } else if (gesture === 'downward correction') {
          area.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -40 }));
          top = 760;
          area.dispatchEvent(new window.Event('scroll'));
          area.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 5 }));
          top = 765;
        } else {
          if (gesture === 'scrollbar during follow') {
            area.dispatchEvent(new window.PointerEvent('pointerdown', { pointerType: 'mouse' }));
          }
          top = 780;
        }
        area.dispatchEvent(new window.Event('scroll'));
        document.dispatchEvent(new window.PointerEvent('pointerup'));
        flushFrames();
        assert.equal(isChatScrollPinned(), false);
        assert.equal(chip.classList.contains('hidden'), false);
        const readingTop = top;
        height = 1600;
        scrollChatIfPinned();
        area.dispatchEvent(new window.Event('load'));
        assert.equal(top, readingTop, 'stream and image layout preserve the reading position');

        area.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 500 }));
        top = 1200;
        area.dispatchEvent(new window.Event('scroll'));
        assert.equal(isChatScrollPinned(), true, 'reaching the actual bottom resumes follow');
        height = 1800;
        scrollChatIfPinned();
        assert.equal(top, 1400);
      } finally {
        flushFrames();
        await window.happyDOM.close();
      }
    });
  }

  test('delayed automatic scroll events and layout shrink keep follow enabled', async () => {
    const window = new Window();
    globalThis.document = window.document;
    let frames = [];
    globalThis.requestAnimationFrame = cb => { frames.push(cb); return frames.length; };
    globalThis.cancelAnimationFrame = () => {};
    const frame = () => {
      const pending = frames;
      frames = [];
      for (const cb of pending) cb();
    };
    const area = document.createElement('main');
    area.id = 'chatArea';
    document.body.append(area);
    let height = 1200;
    let top = 800;
    Object.defineProperties(area, {
      scrollHeight: { get: () => height }, clientHeight: { value: 400 },
      scrollTop: { get: () => top, set: value => { top = Math.min(value, height - 400); } },
    });
    try {
      initChatScroll();
      scrollChatToBottom();
      frame();
      height = 1600;
      scrollChatIfPinned();
      frame(); // The first write's release must not interfere with the second write.
      area.dispatchEvent(new window.Event('scroll'));
      assert.equal(isChatScrollPinned(), true);
      assert.equal(top, 1200);
      while (frames.length) frame();

      // Chromium clamps scrollTop when a disclosure collapses.
      height = 1000;
      top = 600;
      area.dispatchEvent(new window.Event('scroll'));
      assert.equal(isChatScrollPinned(), true, 'layout shrink is not user movement');
      height = 1500;
      scrollChatIfPinned();
      assert.equal(top, 1100);
    } finally {
      while (frames.length) frame();
      await window.happyDOM.close();
    }
  });

  test('touch scrolling releases follow before movement and remains released through iOS momentum', async () => {
    const window = new Window();
    globalThis.document = window.document;
    globalThis.requestAnimationFrame = (cb) => { cb(); return 0; };
    const area = document.createElement('main');
    area.id = 'chatArea';
    document.body.append(area);
    let top = 800;
    Object.defineProperties(area, {
      scrollHeight: { value: 1200 }, clientHeight: { value: 400 },
      scrollTop: { get: () => top, set: (value) => { top = value; } },
    });
    const touch = (type, y) => {
      const event = new window.Event(type);
      Object.defineProperty(event, 'touches', { value: y == null ? [] : [{ clientY: y }] });
      area.dispatchEvent(event);
    };
    try {
      initChatScroll();
      scrollChatToBottom();
      top = 800;
      area.dispatchEvent(new window.PointerEvent('pointerdown', { pointerType: 'touch' }));
      touch('touchstart', 100);
      touch('touchmove', 125);
      assert.equal(isChatScrollPinned(), false);
      top = 780;
      area.dispatchEvent(new window.Event('scroll'));
      assert.equal(captureChatScrollAnchor().pinned, false, 'touch intent wins inside the bottom threshold');
      touch('touchend');
      for (const position of [740, 500, 100, 0]) {
        top = position;
        area.dispatchEvent(new window.Event('scroll'));
        scrollChatIfPinned();
        assert.equal(top, position);
      }
      scrollChatToBottom();
      assert.equal(isChatScrollPinned(), true);
    } finally { await window.happyDOM.close(); }
  });

  test('late transcript layout follows the tail, respects reading position, and cleans up', async () => {
    const window = new Window();
    globalThis.document = window.document;
    globalThis.requestAnimationFrame = (cb) => { cb(); return 0; };
    const observed = new Set();
    let resize;
    window.ResizeObserver = class {
      constructor(callback) { resize = callback; }
      observe(node) { observed.add(node); }
      unobserve(node) { observed.delete(node); }
      disconnect() { observed.clear(); }
    };
    const area = document.createElement('main');
    area.id = 'chatArea';
    const row = document.createElement('div');
    area.append(row);
    document.body.append(area);
    let height = 1200;
    let top = 800;
    let writes = 0;
    Object.defineProperties(area, {
      scrollHeight: { get: () => height },
      clientHeight: { value: 400 },
      scrollTop: {
        get: () => top,
        set: (value) => { top = Math.min(value, height - 400); writes += 1; },
      },
    });
    initChatScroll();
    pinChatScroll();
    const dispose = observeChatScrollLayout(area);
    try {
      assert.ok(observed.has(area));
      assert.ok(observed.has(row), 'fixed-height root alone cannot report transcript growth');
      height = 2100;
      resize();
      assert.equal(top, 1700, 'expanded Full view reaches the new bottom without a scroll event');
      const before = writes;
      resize();
      assert.equal(writes, before, 'settled layout must not keep writing scrollTop');

      area.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -120 }));
      top = 1400;
      height = 2500;
      resize();
      assert.equal(top, 1400, 'late layout must not pull an unpinned reader to the tail');
      assert.equal(isChatScrollPinned(), false);

      const older = document.createElement('div');
      area.prepend(older);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.ok(observed.has(older), 'backfilled rows also report later resizing');
      older.remove();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(observed.has(older), false);

      scrollChatToBottom();
      area.remove();
      const detachedTop = top;
      height = 3000;
      resize();
      assert.equal(top, detachedTop, 'detached transcripts cannot move the active viewport');
      dispose();
      assert.equal(observed.size, 0);
    } finally {
      dispose();
      await window.happyDOM.close();
    }
  });

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
