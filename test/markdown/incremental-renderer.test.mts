/**
 * Phase 5 — incremental streaming markdown must match one-shot final DOM,
 * and must preserve earlier block node identity across ticks.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Window } from 'happy-dom';
import { ASSISTANT_RENDER_DEBOUNCE_MS } from '../../src/constants.ts';

type DomGlobals = typeof globalThis & {
  document: Document;
  window: Window;
  HTMLElement: typeof HTMLElement;
  DocumentFragment: typeof DocumentFragment;
  Element: typeof Element;
};

let win: Window;

function installWindow(): void {
  win = new Window();
  const g = globalThis as DomGlobals;
  g.document = win.document;
  g.window = win as unknown as Window & typeof globalThis.window;
  g.HTMLElement = win.HTMLElement as unknown as typeof HTMLElement;
  g.DocumentFragment = win.DocumentFragment as unknown as typeof DocumentFragment;
  g.Element = win.Element as unknown as typeof Element;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Canonical fixture covering lists, tables, fences, setext, inline HTML. */
function buildFixture(partial: 'full' | 'unterminated-fence' | 'growing'): string {
  const head = [
    'Intro paragraph with **bold** and `code`.',
    '',
    'Setext heading',
    '==============',
    '',
    '- nested',
    '  - list',
    '  - items',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '```ts',
    'const x = 1;',
  ].join('\n');

  if (partial === 'unterminated-fence') {
    return head;
  }
  if (partial === 'growing') {
    return `${head}\nconst y = 2;`;
  }
  return [
    head,
    '```',
    '',
    '```python',
    'print("hi")',
    '```',
    '',
    '<div class="note">inline html</div>',
    '',
    'Trailing prose.',
  ].join('\n');
}

describe('incremental assistant markdown render', () => {
  afterEach(async () => {
    try {
      const { cancelAssistantBubbleRenderDebounce } = await import('../../src/markdown/renderer.ts');
      cancelAssistantBubbleRenderDebounce();
    } catch {
      /* Renderer may not be loaded yet if a test failed before import. */
    }
    win?.close();
  });

  it('chunked streaming matches one-shot final DOM', async () => {
    installWindow();
    // DOMPurify binds to window at module load — import renderer after happy-dom is installed.
    const {
      scheduleAssistantBubbleRender,
      setAssistantBubbleContent,
    } = await import('../../src/markdown/renderer.ts');

    const full = buildFixture('full');
    const bubble = win.document.createElement('div');
    const cursor = win.document.createElement('span');
    cursor.className = 'stream-cursor';
    win.document.body.appendChild(bubble);

    // Grow by chunks (not every char) so the suite stays fast while still exercising dirty suffix.
    const step = 7;
    for (let i = step; i < full.length; i += step) {
      scheduleAssistantBubbleRender(bubble, full.slice(0, i), cursor);
      await sleep(ASSISTANT_RENDER_DEBOUNCE_MS + 8);
    }
    scheduleAssistantBubbleRender(bubble, full, cursor);
    await sleep(ASSISTANT_RENDER_DEBOUNCE_MS + 8);
    // Allow async highlightCodeElement settles.
    await sleep(30);

    const expected = win.document.createElement('div');
    setAssistantBubbleContent(expected, full, { streaming: false });
    await sleep(30);

    cursor.remove();
    // Full-document DOMPurify often unwraps the first `<p>`; per-token wrapped sanitize keeps it.
    // Assert semantic equivalence (text + key structures), not byte-identical HTML.
    assert.equal(bubble.textContent?.replace(/\s+/g, ' ').trim(), expected.textContent?.replace(/\s+/g, ' ').trim());
    assert.equal(bubble.querySelectorAll('h1').length, expected.querySelectorAll('h1').length);
    assert.equal(bubble.querySelector('h1')?.id, 'setext-heading');
    assert.equal(expected.querySelector('h1')?.id, 'setext-heading');
    assert.equal(bubble.querySelectorAll('ul').length, expected.querySelectorAll('ul').length);
    assert.equal(bubble.querySelectorAll('table').length, expected.querySelectorAll('table').length);
    assert.equal(bubble.querySelectorAll('pre').length, expected.querySelectorAll('pre').length);
    assert.equal(bubble.querySelectorAll('pre code').length, expected.querySelectorAll('pre code').length);
    assert.ok(bubble.querySelector('.note'), 'inline HTML block preserved');
  });

  it('preserves earlier block node identity across streaming ticks', async () => {
    installWindow();
    const {
      getAssistantBubbleRenderStateForTests,
      setAssistantBubbleContent,
    } = await import('../../src/markdown/renderer.ts');

    const bubble = win.document.createElement('div');
    const cursor = win.document.createElement('span');
    win.document.body.appendChild(bubble);

    const early = buildFixture('unterminated-fence');
    setAssistantBubbleContent(bubble, early, { streaming: true, streamCursor: cursor });
    const before = getAssistantBubbleRenderStateForTests(bubble);
    assert.ok(before.firstNode, 'expected at least one committed node');
    const preserved = before.firstNode!;

    const later = buildFixture('growing');
    setAssistantBubbleContent(bubble, later, { streaming: true, streamCursor: cursor });
    const after = getAssistantBubbleRenderStateForTests(bubble);
    assert.equal(
      after.firstNode,
      preserved,
      'prefix node identity must survive dirty suffix rebuild',
    );

    const closed = buildFixture('full');
    setAssistantBubbleContent(bubble, closed, { streaming: true, streamCursor: cursor });
    const finalState = getAssistantBubbleRenderStateForTests(bubble);
    assert.equal(finalState.firstNode, preserved);
  });

  it('decorates only new blocks and rolls back heading counts when the suffix changes', async () => {
    installWindow();
    const { setAssistantBubbleContent } = await import('../../src/markdown/renderer.ts');
    const bubble = win.document.createElement('div');
    const prefix = '# Repeat\n\n[stable](https://example.com)\n\n';
    setAssistantBubbleContent(bubble, prefix + '# Repeat', { streaming: true });
    const stableHeading = bubble.querySelector('h1')!;
    const stableLink = bubble.querySelector('a')!;
    let prefixWrites = 0;
    const observer = new win.MutationObserver((records) => { prefixWrites += records.length; });
    observer.observe(stableHeading, { attributes: true });
    observer.observe(stableLink, { attributes: true });
    for (const suffix of ['# Other', '# Repeat', '# Repeat\n\n# Repeat']) {
      setAssistantBubbleContent(bubble, prefix + suffix, { streaming: true });
    }
    await sleep(0);
    observer.disconnect();
    assert.equal(prefixWrites, 0, 'streaming must not rewrite unchanged heading/link attributes');
    assert.equal(bubble.querySelector('h1'), stableHeading);
    assert.deepEqual([...bubble.querySelectorAll('h1')].map((h) => h.id), ['repeat', 'repeat-1', 'repeat-2']);
    assert.equal(stableLink.target, '_blank');
    assert.equal(stableLink.rel, 'noopener noreferrer');
  });

  it('handles late-arriving setext heading without throwing', async () => {
    installWindow();
    const { setAssistantBubbleContent } = await import('../../src/markdown/renderer.ts');
    const bubble = win.document.createElement('div');
    const cursor = win.document.createElement('span');
    setAssistantBubbleContent(bubble, 'Title\n', { streaming: true, streamCursor: cursor });
    setAssistantBubbleContent(bubble, 'Title\n====\n\nbody', {
      streaming: true,
      streamCursor: cursor,
    });
    assert.ok(bubble.querySelector('h1') || bubble.textContent?.includes('Title'));
  });

  it('paints during continuous fast chunks (throttle, not trailing debounce)', async () => {
    installWindow();
    const {
      getAssistantBubbleRenderStateForTests,
      scheduleAssistantBubbleRender,
    } = await import('../../src/markdown/renderer.ts');

    const bubble = win.document.createElement('div');
    const cursor = win.document.createElement('span');
    win.document.body.appendChild(bubble);

    const full = 'Hello world, this is streaming markdown text that grows over time.';
    let midStreamNonEmpty = false;
    let paintCount = 0;
    let prevTextLen = 0;

    for (let t = 0; t < 300; t += 10) {
      const progress = Math.min(1, (t + 10) / 300);
      const partial = full.slice(0, Math.ceil(full.length * progress));
      scheduleAssistantBubbleRender(bubble, partial, cursor);

      const len = bubble.textContent?.replace(/\s/g, '').length ?? 0;
      if (len > 0 && t < 290) {
        midStreamNonEmpty = true;
      }
      if (len > prevTextLen) {
        paintCount += 1;
        prevTextLen = len;
      }
      await sleep(10);
    }

    const state = getAssistantBubbleRenderStateForTests(bubble);
    assert.ok(midStreamNonEmpty, 'expected non-empty bubble before stream end');
    assert.ok(paintCount >= 2, 'expected multiple paints during fast stream');
    assert.ok(state.lastRenderedAt > 0, 'expected scheduler to record at least one paint');
  });

  it('incremental paint keeps a single streaming caret', async () => {
    installWindow();
    const { setAssistantBubbleContent } = await import('../../src/markdown/renderer.ts');
    const bubble = win.document.createElement('div');
    win.document.body.appendChild(bubble);

    const cursor = win.document.createElement('div');
    cursor.className = 'cursor cursor--prose';
    const stray = win.document.createElement('div');
    stray.className = 'cursor cursor--prose';
    bubble.appendChild(stray);
    bubble.appendChild(cursor);

    setAssistantBubbleContent(bubble, 'Hello **there**.', {
      streaming: true,
      streamCursor: cursor,
    });

    assert.equal(bubble.querySelectorAll('.cursor--prose').length, 1);
    assert.equal(bubble.querySelector('.cursor--prose'), cursor);
  });

  it('finishStreamingBubbleRender strips the caret and a cancelled flush cannot restore it', async () => {
    installWindow();
    const {
      cancelAssistantBubbleRenderDebounce,
      finishStreamingBubbleRender,
      scheduleAssistantBubbleRender,
      setAssistantBubbleContent,
    } = await import('../../src/markdown/renderer.ts');

    const bubble = win.document.createElement('div');
    win.document.body.appendChild(bubble);
    const cursor = win.document.createElement('div');
    cursor.className = 'cursor cursor--prose';

    setAssistantBubbleContent(bubble, 'Hello', { streaming: true, streamCursor: cursor });
    scheduleAssistantBubbleRender(bubble, 'Hello world', cursor);
    cancelAssistantBubbleRenderDebounce(bubble);
    finishStreamingBubbleRender(bubble, cursor);
    setAssistantBubbleContent(bubble, 'Hello world', { streaming: false });

    await sleep(ASSISTANT_RENDER_DEBOUNCE_MS + 20);

    assert.equal(bubble.querySelectorAll('.cursor--prose').length, 0);
    assert.ok(bubble.textContent?.includes('Hello world'));
  });
});
