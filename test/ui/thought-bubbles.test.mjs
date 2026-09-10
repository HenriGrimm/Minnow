import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Window } from 'happy-dom';

const {
  ThoughtBubbleController,
  renderThoughtsToggle,
  syncThoughtsCaretPulse,
} = await import('../../src/ui/thought-bubbles.ts');
const { ThinkingDurationTracker } = await import('../../src/ui/thinking-duration.ts');

function setupDom() {
  const window = new Window();
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  const area = document.createElement('div');
  area.id = 'chatArea';
  document.body.appendChild(area);
  return window;
}

function assistantWrap() {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML =
    '<div class="msg-label">Assistant</div><div class="stream-status"></div><div class="msg-bubble"></div>';
  return wrap;
}

describe('ThoughtBubbleController', { concurrency: false }, () => {
  test('reasoning prose is collapsed by default during streaming', () => {
    setupDom();
    const wrap = assistantWrap();
    const ctrl = new ThoughtBubbleController(wrap);

    ctrl.appendReasoningDelta('Hidden reasoning text');

    const flow = wrap.querySelector('.thoughts-flow');
    const toggle = wrap.querySelector('.thoughts-toggle');
    const segment = wrap.querySelector('.thoughts-segment');

    assert.ok(toggle);
    assert.equal(toggle?.getAttribute('aria-expanded'), 'false');
    assert.ok(flow?.hidden);
    assert.equal(segment?.textContent, '');
    assert.ok(wrap.querySelector('.stream-status')?.classList.contains('hidden'));

    ctrl.endReasoningPhase();
  });

  test('click expands to reveal streaming reasoning text', () => {
    setupDom();
    const wrap = assistantWrap();
    const ctrl = new ThoughtBubbleController(wrap);

    ctrl.appendReasoningDelta('Visible when expanded');

    const toggle = wrap.querySelector('.thoughts-toggle');
    toggle?.click();

    const flow = wrap.querySelector('.thoughts-flow');
    const segment = wrap.querySelector('.thoughts-segment');

    assert.equal(toggle?.getAttribute('aria-expanded'), 'true');
    assert.equal(flow?.hidden, false);
    assert.equal(segment?.textContent, 'Visible when expanded');

    toggle?.click();
    assert.equal(toggle?.getAttribute('aria-expanded'), 'false');
    assert.ok(flow?.hidden);

    ctrl.endReasoningPhase();
  });

  test('paragraph boundaries split stored segments', async () => {
    setupDom();
    const wrap = assistantWrap();
    const ctrl = new ThoughtBubbleController(wrap);

    ctrl.appendReasoningDelta('First thought');
    ctrl.appendReasoningDelta('\n\n');
    ctrl.appendReasoningDelta('Second thought');

    await ctrl.flushPendingWork();

    assert.deepEqual(ctrl.getSegmentsNormalized(), [
      'First thought',
      'Second thought',
    ]);

    ctrl.endReasoningPhase();
  });

  test('setThinkingElapsed updates live toggle label', () => {
    setupDom();
    const wrap = assistantWrap();
    const ctrl = new ThoughtBubbleController(wrap);

    ctrl.appendReasoningDelta('Reasoning');
    ctrl.setThinkingElapsed(5000);

    const label = wrap.querySelector('.thoughts-toggle__label');
    assert.equal(label?.textContent, 'Thinking… 5.0s');

    ctrl.endReasoningPhase();
  });

  test('endReasoningPhase is idempotent and stops thinking timer for tool calls', () => {
    let now = 0;
    const original = performance.now;
    performance.now = () => now;

    setupDom();
    const wrap = assistantWrap();
    let reasoningEndedCount = 0;
    const tracker = new ThinkingDurationTracker();
    const ctrl = new ThoughtBubbleController(wrap, {
      onThinkingStart: () => tracker.startSegment(),
      onReasoningEnded: () => {
        reasoningEndedCount += 1;
        tracker.endSegment();
      },
    });

    ctrl.appendReasoningDelta('Plan the tool call');
    now += 250;
    ctrl.endReasoningPhase();

    now += 8000;
    assert.equal(reasoningEndedCount, 1);
    assert.equal(tracker.getElapsedMs(), 250);

    ctrl.endReasoningPhase();
    assert.equal(reasoningEndedCount, 1);
    assert.equal(tracker.getElapsedMs(), 250);

    performance.now = original;
  });

  test('endReasoningPhase keeps thoughts on the row as a settled toggle', () => {
    setupDom();
    const wrap = assistantWrap();
    const ctrl = new ThoughtBubbleController(wrap);

    ctrl.appendReasoningDelta('Plan the tool call');
    ctrl.setThinkingElapsed(2500);
    wrap.querySelector('.thoughts-toggle')?.click();
    assert.equal(wrap.querySelector('.thoughts-panel-wrap--live'), wrap.querySelector('.thoughts-panel-wrap'));

    ctrl.endReasoningPhase();

    const panel = wrap.querySelector('.thoughts-panel-wrap');
    const toggle = wrap.querySelector('.thoughts-toggle');
    const flow = wrap.querySelector('.thoughts-flow');
    assert.ok(panel, 'settled thoughts must stay on the assistant row');
    assert.equal(panel?.classList.contains('thoughts-panel-wrap--live'), false);
    assert.equal(wrap.querySelector('.thought-stage'), null);
    assert.equal(toggle?.querySelector('.thoughts-toggle__label')?.textContent, 'Thought for 2.5s');
    assert.equal(toggle?.getAttribute('aria-expanded'), 'true');
    assert.equal(flow?.hidden, false);
    assert.equal(wrap.querySelector('.thoughts-segment')?.textContent, 'Plan the tool call');
    assert.deepEqual(ctrl.getSegmentsNormalized(), ['Plan the tool call']);
  });

  test('consumePersistedSegments returns segments and clears state for the next response', () => {
    setupDom();
    const wrap = assistantWrap();
    const ctrl = new ThoughtBubbleController(wrap);

    ctrl.appendReasoningDelta('First response');
    assert.deepEqual(ctrl.consumePersistedSegments(), ['First response']);
    assert.deepEqual(ctrl.getSegmentsNormalized(), []);

    ctrl.appendReasoningDelta('Second response');
    assert.deepEqual(ctrl.consumePersistedSegments(), ['Second response']);

    ctrl.endReasoningPhase();
  });
});

describe('renderThoughtsToggle', () => {
  test('durationMs updates button label and starts collapsed', () => {
    setupDom();
    const wrap = assistantWrap();
    renderThoughtsToggle(wrap, ['Segment one'], { durationMs: 5000 });
    const btn = wrap.querySelector('.thoughts-toggle');
    const flow = wrap.querySelector('.thoughts-flow');
    assert.equal(btn?.querySelector('.thoughts-toggle__label')?.textContent, 'Thought for 5.0s');
    assert.equal(btn?.getAttribute('aria-label'), 'Thought for 5.0s');
    assert.equal(btn?.getAttribute('aria-expanded'), 'false');
    assert.ok(flow?.hidden);
  });

  test('click toggles persisted reasoning visibility', () => {
    setupDom();
    const wrap = assistantWrap();
    renderThoughtsToggle(wrap, ['Segment one']);
    const btn = wrap.querySelector('.thoughts-toggle');
    const flow = wrap.querySelector('.thoughts-flow');

    btn?.click();
    assert.equal(btn?.getAttribute('aria-expanded'), 'true');
    assert.equal(flow?.hidden, false);

    btn?.click();
    assert.equal(btn?.getAttribute('aria-expanded'), 'false');
    assert.ok(flow?.hidden);
  });

  test('collapsed settled toggle does not pulse by default', () => {
    setupDom();
    const wrap = assistantWrap();
    renderThoughtsToggle(wrap, ['Segment one']);
    const caret = wrap.querySelector('.thoughts-caret');
    assert.ok(caret);
    assert.equal(caret.classList.contains('thoughts-caret--pulse'), false);
    assert.equal(caret.classList.contains('thoughts-caret--expanded'), false);
  });

  test('pulse: true makes the collapsed caret pulse', () => {
    setupDom();
    const wrap = assistantWrap();
    renderThoughtsToggle(wrap, ['Segment one'], { pulse: true });
    const caret = wrap.querySelector('.thoughts-caret');
    assert.ok(caret);
    assert.equal(caret.classList.contains('thoughts-caret--pulse'), true);
  });
});

describe('syncThoughtsCaretPulse', () => {
  function mountWithRows(count, { pulse = true } = {}) {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const carets = [];
    for (let i = 0; i < count; i += 1) {
      const wrap = assistantWrap();
      mount.appendChild(wrap);
      renderThoughtsToggle(wrap, [`Segment ${i}`], { pulse });
      carets.push(wrap.querySelector('.thoughts-caret'));
    }
    return { mount, carets };
  }

  test('de-pulses all but the last caret in DOM order', () => {
    setupDom();
    const { mount, carets } = mountWithRows(3);
    assert.equal(carets[0].classList.contains('thoughts-caret--pulse'), true);
    assert.equal(carets[1].classList.contains('thoughts-caret--pulse'), true);
    assert.equal(carets[2].classList.contains('thoughts-caret--pulse'), true);
    syncThoughtsCaretPulse(mount);
    assert.equal(carets[0].classList.contains('thoughts-caret--pulse'), false);
    assert.equal(carets[1].classList.contains('thoughts-caret--pulse'), false);
    assert.equal(carets[2].classList.contains('thoughts-caret--pulse'), true);
  });

  test('expanding the newest toggle stops its pulse; collapsing restores it', () => {
    setupDom();
    const { mount, carets } = mountWithRows(3);
    syncThoughtsCaretPulse(mount);
    const lastBtn = carets[2].closest('.thoughts-toggle');
    lastBtn.click();
    assert.equal(carets[2].classList.contains('thoughts-caret--expanded'), true);
    assert.equal(carets[2].classList.contains('thoughts-caret--pulse'), false);
    lastBtn.click();
    assert.equal(carets[2].classList.contains('thoughts-caret--expanded'), false);
    assert.equal(carets[2].classList.contains('thoughts-caret--pulse'), true);
  });

  test('live stage is the only pulsing caret alongside a prior settled toggle', () => {
    setupDom();
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const priorWrap = assistantWrap();
    mount.appendChild(priorWrap);
    renderThoughtsToggle(priorWrap, ['Prior thought'], { pulse: true });
    const priorCaret = priorWrap.querySelector('.thoughts-caret');
    const liveWrap = assistantWrap();
    mount.appendChild(liveWrap);
    const ctrl = new ThoughtBubbleController(liveWrap);
    ctrl.appendReasoningDelta('Live reasoning');
    const liveCaret = liveWrap.querySelector('.thoughts-caret');
    assert.ok(liveCaret);
    assert.equal(priorCaret.classList.contains('thoughts-caret--pulse'), false);
    assert.equal(liveCaret.classList.contains('thoughts-caret--pulse'), true);
    ctrl.endReasoningPhase();
  });
});

describe('anchorPersistedThoughtsOnRow', () => {
  test('pins thinking on a row and removes empty streaming chrome', async () => {
    setupDom();
    const { anchorPersistedThoughtsOnRow } = await import('../../src/ui/messages.ts');
    const wrap = assistantWrap();
    const streamStatus = wrap.querySelector('.stream-status');

    anchorPersistedThoughtsOnRow(wrap, ['Round one thought'], { durationMs: 2500 });

    assert.ok(wrap.querySelector('.thoughts-panel-wrap'));
    assert.equal(
      wrap.querySelector('.thoughts-toggle__label')?.textContent,
      'Thought for 2.5s',
    );
    assert.equal(wrap.querySelector('.msg-bubble'), null);
    assert.equal(wrap.querySelector('.stream-status'), null);
    assert.equal(streamStatus?.isConnected, false);
  });
});
