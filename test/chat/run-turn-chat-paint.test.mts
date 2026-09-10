/**
 * P6-A / P7-B onEvent → existing chat DOM helpers, coalesced onto one paint tick.
 */

import '../tools/install-dom-before-imports.mts';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  coerceToolCallArgs,
  createChatTurnEventPainter,
  finalizeAndAnchorThinkingRound,
  parsePaintToolArguments,
  thinkingDeltaFromSnapshot,
} from '../../src/chat/run-turn-chat-paint.ts';
import { TOOL_ARGUMENTS_INVALID_JSON } from '../../src/tools/parse-tool-arguments.ts';
import { ThoughtBubbleController } from '../../src/ui/thought-bubbles.ts';
import { renderToolCall } from '../../src/ui/tool-messages.ts';
import { resetShellRunRegistryForTests } from '../../src/ui/shell-run-registry.ts';

function hostStub(overrides: {
  schedulePaintTick?: (cb: () => void) => void;
  scrollTranscript?: () => void;
  scheduleMarkdown?: (
    bubble: HTMLElement,
    markdown: string,
    streamCursor: HTMLElement,
    opts?: { immediate?: boolean },
  ) => void;
  chatId?: string;
  isDomVisible?: () => boolean;
} = {}) {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant msg--awaiting-prose';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  const cursor = document.createElement('div');
  wrap.appendChild(bubble);
  bubble.appendChild(cursor);
  mount.appendChild(wrap);
  const thinking: string[] = [];
  let revealed = false;
  const activity: string[] = [];
  return {
    mount,
    wrap,
    bubble,
    cursor,
    thinking,
    get revealed() {
      return revealed;
    },
    activity,
    host: {
      wrap,
      bubble,
      cursor,
      thoughtController: {
        appendReasoningDelta: (delta: string) => {
          thinking.push(delta);
        },
      },
      mount,
      revealProse: () => {
        revealed = true;
      },
      onActivity: () => {
        activity.push('tick');
      },
      ...overrides,
    },
  };
}

describe('P6-A chat turn event painter (MIN-723)', () => {
  test('thinkingDeltaFromSnapshot diffs a cumulative snapshot', () => {
    assert.equal(thinkingDeltaFromSnapshot('', 'abc'), 'abc');
    assert.equal(thinkingDeltaFromSnapshot('ab', 'abcd'), 'cd');
    assert.equal(thinkingDeltaFromSnapshot('xy', 'ab'), 'ab');
  });

  test('coerceToolCallArgs parses a JSON string from the wire', () => {
    assert.deepEqual(coerceToolCallArgs('{"expression":"1+1"}'), { expression: '1+1' });
    assert.deepEqual(coerceToolCallArgs({ expression: '1+1' }), { expression: '1+1' });
    // Malformed JSON must not become `{ raw }` — that used to paint as args.
    assert.deepEqual(coerceToolCallArgs('{not json'), {});
    const parsed = parsePaintToolArguments('{not json');
    assert.equal(parsed.parseError, TOOL_ARGUMENTS_INVALID_JSON);
    assert.deepEqual(parsed.args, {});
  });

  test('maps delta, thinking, tool_call, and tool_result onto existing helpers', () => {
    const stub = hostStub();
    const painter = createChatTurnEventPainter(stub.host);

    painter.onEvent({ type: 'thinking', text: 'Let me look.' });
    painter.onEvent({ type: 'thinking', text: 'Let me look. Then call.' });
    painter.onEvent({ type: 'delta', text: 'The time is ' });
    painter.onEvent({ type: 'delta', text: 'The time is noon.' });
    painter.onEvent({
      type: 'tool_call',
      name: 'get_datetime',
      id: 'call_dt',
      arguments: '{}',
    });
    painter.onEvent({
      type: 'tool_result',
      name: 'get_datetime',
      id: 'call_dt',
      content: '2026-08-31T12:00:00.000Z',
    });

    const snap = painter.snapshot();
    assert.equal(snap.lastDelta, 'The time is noon.');
    assert.equal(snap.lastThinking, 'Let me look. Then call.');
    assert.equal(snap.toolCallCount, 1);
    assert.equal(stub.revealed, true);
    // tool_call flushes pending snapshots; latest thinking wins as one append.
    assert.deepEqual(stub.thinking, ['Let me look. Then call.']);
    const toolRow = stub.mount.querySelector('.tool-call-msg');
    assert.ok(toolRow, 'tool_call must append a .tool-call-msg row');
    // `renderToolResult` removes aria-busy rather than setting it to "false".
    assert.equal(toolRow?.hasAttribute('aria-busy'), false);
    assert.ok(
      stub.mount.textContent?.includes('2026-08-31T12:00:00.000Z') ||
        toolRow?.textContent?.includes('2026-08-31'),
      'tool_result must fill the existing tool row',
    );
    assert.ok(stub.activity.length >= 4);
  });

  test('tool_streaming shows Calling… and retarget keeps it across remount', () => {
    const stub = hostStub();
    const streamStatus = {
      setPhase() {},
      setThinkingElapsed() {},
      setRuntimeDetail() {},
      dispose() {},
    };
    const painter = createChatTurnEventPainter({
      ...stub.host,
      streamStatus,
    });

    painter.onEvent({ type: 'tool_streaming', name: 'get_datetime' });
    const firstLabel = stub.wrap.querySelector('.tool-start-indicator__label')?.textContent;
    assert.ok(firstLabel?.startsWith('Calling '), `got ${firstLabel}`);

    const wrap2 = document.createElement('div');
    wrap2.className = 'msg assistant';
    const bubble2 = document.createElement('div');
    bubble2.className = 'msg-bubble';
    const cursor2 = document.createElement('div');
    wrap2.appendChild(bubble2);
    bubble2.appendChild(cursor2);
    stub.mount.appendChild(wrap2);

    painter.retarget({ wrap: wrap2, bubble: bubble2, cursor: cursor2, streamStatus });
    const remountLabel = wrap2.querySelector('.tool-start-indicator__label')?.textContent;
    assert.equal(remountLabel, firstLabel);

    painter.onEvent({
      type: 'tool_call',
      name: 'get_datetime',
      id: 'call_dt',
      arguments: '{}',
    });
    assert.equal(wrap2.querySelector('.tool-start-indicator'), null);
  });
});

describe('P7-B coalesced chat paint (MIN-729)', () => {
  test('a burst of thinking/delta events is one scroll and one markdown schedule per tick', () => {
    const ticks: Array<() => void> = [];
    let scrolls = 0;
    let markdowns = 0;
    let coalescedPaints = 0;
    const stub = hostStub({
      schedulePaintTick: (cb) => {
        ticks.push(cb);
      },
      scrollTranscript: () => {
        scrolls += 1;
      },
      scheduleMarkdown: () => {
        markdowns += 1;
      },
    });
    const painter = createChatTurnEventPainter({
      ...stub.host,
      onCoalescedPaint: () => {
        coalescedPaints += 1;
      },
    });

    const burst = 20;
    for (let i = 1; i <= burst; i += 1) {
      painter.onEvent({ type: 'thinking', text: 'x'.repeat(i) });
      painter.onEvent({ type: 'delta', text: 'y'.repeat(i) });
    }

    assert.equal(ticks.length, 1, 'one rAF scheduled for the burst');
    assert.equal(scrolls, 0, 'no scroll before the paint tick');
    assert.equal(markdowns, 0, 'no markdown schedule before the paint tick');
    assert.deepEqual(stub.thinking, []);
    assert.equal(stub.revealed, false);

    ticks[0]();

    assert.equal(scrolls, 1);
    assert.equal(markdowns, 1);
    assert.equal(coalescedPaints, 1, 'live stats / context overlay hook fires once per paint tick');
    assert.deepEqual(stub.thinking, ['x'.repeat(burst)]);
    assert.equal(stub.revealed, true);
    assert.equal(painter.snapshot().lastDelta, 'y'.repeat(burst));
    assert.equal(painter.snapshot().lastThinking, 'x'.repeat(burst));
  });

  test('thinking prefix-diffs against the last painted snapshot across ticks', () => {
    const ticks: Array<() => void> = [];
    const stub = hostStub({
      schedulePaintTick: (cb) => {
        ticks.push(cb);
      },
      scrollTranscript: () => {},
      scheduleMarkdown: () => {},
    });
    const painter = createChatTurnEventPainter(stub.host);

    painter.onEvent({ type: 'thinking', text: 'Let me' });
    ticks[0]();
    assert.deepEqual(stub.thinking, ['Let me']);

    painter.onEvent({ type: 'thinking', text: 'Let me look.' });
    painter.onEvent({ type: 'thinking', text: 'Let me look. Then call.' });
    assert.equal(ticks.length, 2);
    ticks[1]();
    assert.deepEqual(stub.thinking, ['Let me', ' look. Then call.']);
  });

  test('tool_call still paints immediately without waiting for a paint tick', () => {
    const ticks: Array<() => void> = [];
    const stub = hostStub({
      schedulePaintTick: (cb) => {
        ticks.push(cb);
      },
      scrollTranscript: () => {},
      scheduleMarkdown: () => {},
    });
    const painter = createChatTurnEventPainter(stub.host);

    painter.onEvent({
      type: 'tool_call',
      name: 'get_datetime',
      id: 'call_now',
      arguments: '{}',
    });

    assert.equal(ticks.length, 0, 'tools do not schedule a transcript paint');
    assert.ok(stub.mount.querySelector('.tool-call-msg'), 'tool row appears immediately');
  });

  test('tool_streaming flushes the latest delta immediately, not the first token', () => {
    // Do not leave "Paths" on screen while the 100ms markdown debounce waits.
    const ticks: Array<() => void> = [];
    const markdownCalls: Array<{ text: string; immediate?: boolean }> = [];
    const stub = hostStub({
      schedulePaintTick: (cb) => {
        ticks.push(cb);
      },
      scrollTranscript: () => {},
      scheduleMarkdown: (_bubble, markdown, _cursor, opts) => {
        markdownCalls.push({ text: markdown, immediate: opts?.immediate });
      },
    });
    const painter = createChatTurnEventPainter(stub.host);

    painter.onEvent({ type: 'delta', text: 'Paths' });
    painter.onEvent({ type: 'delta', text: 'Paths verified. Writing the plan file now.' });
    assert.equal(markdownCalls.length, 0, 'rAF not flushed yet');

    painter.onEvent({ type: 'tool_streaming', name: 'save_file' });

    assert.equal(markdownCalls.length, 1);
    assert.equal(markdownCalls[0]?.text, 'Paths verified. Writing the plan file now.');
    assert.equal(markdownCalls[0]?.immediate, true);
  });
});

function roundEnd(
  index: number,
  text: string,
  reasoning: string,
  toolCallCount: number,
): Extract<import('../../server/runner/run-turn').TurnEvent, { type: 'round_end' }> {
  return {
    type: 'round_end',
    index,
    text,
    reasoning,
    toolCallCount,
    t0: 0,
    tFirst: 1,
    tEnd: 2,
  };
}

function appendAssistantShell(mount: HTMLElement) {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant msg--awaiting-prose';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  const cursor = document.createElement('div');
  wrap.appendChild(bubble);
  bubble.appendChild(cursor);
  mount.appendChild(wrap);
  return { wrap, bubble, cursor };
}

describe('P10-F per-round transcript rows (MIN-771)', () => {
  test('reasoning_end flushes pending thinking then ends the reasoning phase', () => {
    const ticks: Array<() => void> = [];
    let ended = 0;
    const stub = hostStub({
      schedulePaintTick: (cb) => {
        ticks.push(cb);
      },
      scrollTranscript: () => {},
      scheduleMarkdown: () => {},
    });
    const painter = createChatTurnEventPainter({
      ...stub.host,
      thoughtController: {
        appendReasoningDelta: (delta: string) => {
          stub.thinking.push(delta);
        },
        endReasoningPhase: () => {
          ended += 1;
        },
      },
    });

    painter.onEvent({ type: 'thinking', text: 'Let me look.' });
    assert.equal(ticks.length, 1);
    assert.deepEqual(stub.thinking, []);
    assert.equal(ended, 0);

    painter.onEvent({ type: 'reasoning_end' });
    assert.deepEqual(stub.thinking, ['Let me look.']);
    assert.equal(ended, 1);
  });

  test('thoughts stay on the assistant row while a tool call is still streaming', () => {
    const stub = hostStub({
      schedulePaintTick: (cb) => {
        cb();
      },
      scrollTranscript: () => {},
      scheduleMarkdown: () => {},
    });
    const thoughts = new ThoughtBubbleController(stub.wrap);
    const streamStatus = {
      setPhase() {},
      setThinkingElapsed() {},
      setRuntimeDetail() {},
      dispose() {},
    };
    const painter = createChatTurnEventPainter({
      ...stub.host,
      streamStatus,
      thoughtController: thoughts,
    });

    painter.onEvent({ type: 'thinking', text: 'Need the clock before I answer.' });
    painter.onEvent({ type: 'reasoning_end' });
    painter.onEvent({ type: 'tool_streaming', name: 'get_datetime' });

    const panel = stub.wrap.querySelector('.thoughts-panel-wrap');
    assert.ok(panel, 'reasoning_end must settle thoughts before Calling…');
    assert.equal(panel?.classList.contains('thoughts-panel-wrap--live'), false);
    assert.equal(stub.wrap.querySelector('.thought-stage'), null);
    assert.equal(
      stub.wrap.querySelector('.thoughts-segment')?.textContent,
      'Need the clock before I answer.',
    );
    assert.ok(stub.wrap.querySelector('.tool-start-indicator'), 'Calling… still mounts');
  });

  test('round_end with tools finalizes one thought group per round and keeps tool rows under the caller', () => {
    const ticks: Array<() => void> = [];
    const durations: number[] = [1100, 2300];
    let durationIdx = 0;
    const stub = hostStub({
      schedulePaintTick: (cb) => {
        ticks.push(cb);
      },
      scrollTranscript: () => {},
      scheduleMarkdown: (_bubble, markdown) => {
        _bubble.textContent = markdown;
      },
    });

    const makeThoughts = () => {
      let buffer = '';
      return {
        appendReasoningDelta: (delta: string) => {
          buffer += delta;
        },
        consumePersistedSegments: () => {
          const segs = buffer.trim() ? [buffer.trim()] : [];
          buffer = '';
          return segs;
        },
        endReasoningPhase: () => {},
      };
    };

    let thoughts = makeThoughts();
    const painter = createChatTurnEventPainter({
      ...stub.host,
      thoughtController: thoughts,
      finalizeThinkingRound: () => durations[durationIdx++] ?? 0,
      beginNextStreamingRow: () => {
        const next = appendAssistantShell(stub.mount);
        thoughts = makeThoughts();
        return {
          wrap: next.wrap,
          bubble: next.bubble,
          cursor: next.cursor,
          thoughtController: thoughts,
        };
      },
    });

    painter.onEvent({ type: 'round_start', index: 0 });
    painter.onEvent({ type: 'thinking', text: 'need the clock' });
    painter.onEvent({ type: 'reasoning_end' });
    painter.onEvent({ type: 'delta', text: 'Let me check.' });
    ticks.forEach((tick) => tick());
    ticks.length = 0;
    painter.onEvent({
      type: 'tool_call',
      name: 'get_datetime',
      id: 'call_dt',
      arguments: '{}',
    });
    painter.onEvent({
      type: 'tool_result',
      name: 'get_datetime',
      id: 'call_dt',
      content: 'noon',
    });
    painter.onEvent(roundEnd(0, 'Let me check.', 'need the clock', 1));

    painter.onEvent({ type: 'round_start', index: 1 });
    painter.onEvent({ type: 'thinking', text: 'got it' });
    painter.onEvent({ type: 'reasoning_end' });
    painter.onEvent({ type: 'delta', text: 'It is noon.' });
    ticks.forEach((tick) => tick());
    // Last round has no tools — turn-end closes it (same helper the caller uses).
    painter.flush();
    const lastWrap = stub.mount.querySelectorAll('.msg.assistant')[1] as HTMLElement;
    finalizeAndAnchorThinkingRound({
      thoughtController: thoughts,
      wrap: lastWrap,
      hasProse: true,
      durationMs: durations[durationIdx++] ?? 0,
    });

    const assistants = [...stub.mount.querySelectorAll('.msg.assistant')];
    assert.equal(assistants.length, 2, 'two assistant rows, one per model round');
    const children = [...stub.mount.children];
    assert.equal(children[0], assistants[0]);
    assert.ok(children[1]?.classList.contains('tool-call-msg'), 'tool row sits under round-1 assistant');
    assert.equal(children[2], assistants[1]);

    const toggles = assistants.map((row) => row.querySelectorAll('.thoughts-toggle').length);
    assert.deepEqual(toggles, [1, 1], 'one Thoughts toggle per round');
    assert.equal(
      assistants[0]?.querySelector('.thoughts-toggle__label')?.textContent,
      'Thought for 1.1s',
    );
    assert.equal(
      assistants[1]?.querySelector('.thoughts-toggle__label')?.textContent,
      'Thought for 2.3s',
    );
    assert.equal(assistants[0]?.querySelector('.msg-bubble')?.textContent?.trim(), 'Let me check.');
    assert.equal(assistants[1]?.querySelector('.msg-bubble')?.textContent?.trim(), 'It is noon.');
  });

  test('round_end with no tools does not open a second streaming row', () => {
    const stub = hostStub({
      schedulePaintTick: (cb) => {
        cb();
      },
      scrollTranscript: () => {},
      scheduleMarkdown: () => {},
    });
    let opened = 0;
    const painter = createChatTurnEventPainter({
      ...stub.host,
      beginNextStreamingRow: () => {
        opened += 1;
      },
    });
    painter.onEvent({ type: 'delta', text: 'Hello.' });
    painter.onEvent(roundEnd(0, 'Hello.', '', 0));
    assert.equal(opened, 0);
    assert.equal(stub.mount.querySelectorAll('.msg.assistant').length, 1);
  });
});

describe('P10-H tool-row chrome (MIN-773)', () => {
  test('malformed tool arguments paint an error row, not { raw }', () => {
    const stub = hostStub();
    const painter = createChatTurnEventPainter(stub.host);

    painter.onEvent({
      type: 'tool_call',
      name: 'read_file',
      id: 'call_bad',
      arguments: '{not json',
    });
    const row = stub.mount.querySelector('.tool-call-msg');
    assert.ok(row);
    assert.equal(row?.textContent?.includes('{ raw'), false);

    painter.onEvent({
      type: 'tool_result',
      name: 'read_file',
      id: 'call_bad',
      content: TOOL_ARGUMENTS_INVALID_JSON,
      isError: true,
    });
    assert.ok(row?.classList.contains('tool-call-msg--fail'));
    assert.ok(row?.textContent?.includes('not valid JSON'));
  });

  test('save_file tool_result shows the code-change badge', () => {
    const stub = hostStub();
    const painter = createChatTurnEventPainter(stub.host);
    painter.onEvent({
      type: 'tool_call',
      name: 'save_file',
      id: 'call_save',
      arguments: '{"path":"a.ts"}',
    });
    painter.onEvent({
      type: 'tool_result',
      name: 'save_file',
      id: 'call_save',
      content: 'Saved a.ts',
      codeChange: { additions: 12, deletions: 3, path: 'a.ts' },
    });
    const badge = stub.mount.querySelector('.tool-call-code-change');
    assert.ok(badge);
    assert.equal(badge?.querySelector('.tool-call-code-change__add')?.textContent, '+12');
    assert.equal(badge?.querySelector('.tool-call-code-change__del')?.textContent, '−3');
  });

  test('screenshot tool_result shows the image attachment', () => {
    const stub = hostStub();
    const painter = createChatTurnEventPainter(stub.host);
    painter.onEvent({
      type: 'tool_call',
      name: 'browser_screenshot',
      id: 'call_shot',
      arguments: '{}',
    });
    painter.onEvent({
      type: 'tool_result',
      name: 'browser_screenshot',
      id: 'call_shot',
      content: 'Screenshot saved: abc.png',
      attachments: [
        {
          type: 'image',
          url: '/api/browser/screenshot/abc',
          mime: 'image/png',
          alt: 'Browser screenshot',
        },
      ],
    });
    assert.ok(stub.mount.querySelector('.tool-call-screenshot'));
  });

  test('execute_command reveals Stop after a background runId result', () => {
    resetShellRunRegistryForTests();
    // attachShellKillUi → refreshShellKillUi uses CSS.escape; this paint
    // harness's happy-dom window does not install `CSS` (shell-run-kill tests do).
    const css = globalThis as typeof globalThis & { CSS?: { escape: (s: string) => string } };
    if (typeof css.CSS === 'undefined') {
      css.CSS = { escape: (s: string) => s.replace(/["\\]/g, '\\$&') };
    }
    const stub = hostStub();
    const painter = createChatTurnEventPainter({
      ...stub.host,
      chatId: 'chat-shell',
    });
    painter.onEvent({
      type: 'tool_call',
      name: 'execute_command',
      id: 'call_sh',
      arguments: '{"command":"sleep 60"}',
    });
    const row = stub.mount.querySelector('.tool-call-msg');
    const killBtn = row?.querySelector<HTMLButtonElement>('.tool-call-kill');
    assert.ok(killBtn, 'Stop button is part of the execute_command row');
    assert.ok(killBtn?.classList.contains('hidden'), 'hidden until a run is registered');

    painter.onEvent({
      type: 'tool_result',
      name: 'execute_command',
      id: 'call_sh',
      content: JSON.stringify({
        ok: true,
        background: true,
        runId: '11111111-1111-1111-1111-111111111111',
      }),
    });
    assert.equal(killBtn?.classList.contains('hidden'), false);
    resetShellRunRegistryForTests();
  });

  test('stranded wrap re-resolves by toolCallId after a mid-batch remount', () => {
    const stub = hostStub();
    const painter = createChatTurnEventPainter(stub.host);
    painter.onEvent({
      type: 'tool_call',
      name: 'get_datetime',
      id: 'call_live',
      arguments: '{}',
    });
    const stranded = stub.mount.querySelector('.tool-call-msg') as HTMLElement;
    assert.ok(stranded);

    // Chat switch rebuilds the transcript from history: the captured node is
    // gone and a fresh row carries the same data-tool-call-id (MIN-649).
    stub.mount.replaceChildren();
    const redrawn = renderToolCall('get_datetime', {});
    redrawn.dataset.toolCallId = 'call_live';
    stub.mount.appendChild(redrawn);
    assert.equal(stranded.isConnected, false);
    assert.equal(redrawn.isConnected, true);

    painter.onEvent({
      type: 'tool_result',
      name: 'get_datetime',
      id: 'call_live',
      content: 'noon',
    });
    assert.equal(redrawn.querySelector('.tool-call-body')?.dataset.resultRendered, 'true');
    assert.notEqual(
      stranded.querySelector('.tool-call-body')?.dataset.resultRendered,
      'true',
    );
  });

  test('tool_call and delta do not paint into a shared mount after switching away', () => {
    const ticks: Array<() => void> = [];
    let visible = true;
    const stub = hostStub({
      schedulePaintTick: (cb) => {
        ticks.push(cb);
      },
      scheduleMarkdown: (bubble, markdown) => {
        bubble.textContent = markdown;
      },
      chatId: '11111111-1111-1111-1111-111111111111',
      isDomVisible: () => visible,
    });
    const painter = createChatTurnEventPainter(stub.host);

    painter.onEvent({ type: 'delta', text: 'Hello from A' });
    ticks[0]?.();
    assert.equal(stub.bubble.textContent, 'Hello from A');

    // switchChat wipes the shared #chatArea and paints B's history.
    visible = false;
    stub.mount.replaceChildren();
    const bUser = document.createElement('div');
    bUser.className = 'msg user';
    bUser.textContent = 'B history';
    stub.mount.appendChild(bUser);

    painter.onEvent({
      type: 'tool_call',
      name: 'get_datetime',
      id: 'call_switch',
      arguments: '{}',
    });
    painter.onEvent({ type: 'delta', text: 'Hello from A still streaming' });
    ticks[1]?.();

    assert.equal(
      stub.mount.querySelector('.tool-call-msg'),
      null,
      'tool_call must not append into B',
    );
    assert.equal(stub.mount.textContent?.includes('Hello from A still streaming'), false);
    assert.match(stub.mount.textContent ?? '', /B history/);
    assert.equal(painter.snapshot().lastDelta, 'Hello from A still streaming');

    // Switch back: remount a stream shell; in-memory snapshot catches up.
    visible = true;
    stub.mount.replaceChildren();
    const nextWrap = document.createElement('div');
    const nextBubble = document.createElement('div');
    const nextCursor = document.createElement('div');
    nextWrap.appendChild(nextBubble);
    nextBubble.appendChild(nextCursor);
    stub.mount.appendChild(nextWrap);
    painter.retarget({
      wrap: nextWrap,
      bubble: nextBubble,
      cursor: nextCursor,
      mount: stub.mount,
    });
    assert.equal(nextBubble.textContent, 'Hello from A still streaming');
  });
});
