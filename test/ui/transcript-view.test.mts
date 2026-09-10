/**
 * Benchmark / sub-agent transcript rendering (full message text + images).
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import { MULTIMODAL_PROBE_PROMPT } from '../../src/benchmark/fixtures/multimodal-probe.ts';
import { appendTranscriptLiveTail, renderTranscriptView } from '../../src/ui/transcript-view.ts';
import { subAgentTranscriptLiveFromRun } from '../../src/ui/sub-agent-live-status.ts';

function setupDom(): Window {
  const window = new Window();
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  document.body.innerHTML = '<div id="transcriptBody"></div>';
  return window;
}

describe('renderTranscriptView', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  test('shows full user string and assistant reply for speed-style probe', () => {
    setupDom();
    const body = document.getElementById('transcriptBody')!;
    const userPrompt =
      'Write exactly three short sentences about local LLM inference. No preamble.';
    const assistant =
      'Local LLMs run on your machine. They keep data private. Inference speed depends on hardware.';

    renderTranscriptView(body, [
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: assistant },
    ]);

    const userEl = body.querySelector('.transcript-view__user');
    const assistantEl = body.querySelector('.transcript-view__assistant');
    assert.equal(userEl?.textContent, userPrompt);
    assert.equal(assistantEl?.textContent, assistant);
  });

  test('shows Thoughts toggle for reasoning-only assistant (not as prose)', () => {
    setupDom();
    const body = document.getElementById('transcriptBody')!;
    renderTranscriptView(body, [
      { role: 'user', content: 'Count to three.' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'One, two, three.',
      },
    ]);

    assert.equal(body.querySelector('.transcript-view__assistant'), null);
    assert.equal(
      body.querySelector('.thoughts-toggle__label')?.textContent,
      'Thoughts',
    );
    assert.equal(
      body.querySelector('.thoughts-segment')?.textContent,
      'One, two, three.',
    );
    assert.equal(body.textContent?.includes('(empty assistant message)'), false);
  });

  test('shows Thoughts toggle before prose when both exist', () => {
    setupDom();
    const body = document.getElementById('transcriptBody')!;
    renderTranscriptView(body, [
      { role: 'user', content: 'Solve the bat-and-ball puzzle.' },
      {
        role: 'assistant',
        content: 'The ball costs $0.05.',
        reasoning_content: '1.10 - 1.00 = 0.10',
      },
    ]);

    assert.equal(
      body.querySelector('.transcript-view__assistant')?.textContent,
      'The ball costs $0.05.',
    );
    assert.equal(
      body.querySelector('.thoughts-segment')?.textContent,
      '1.10 - 1.00 = 0.10',
    );
    const turn = body.querySelector('.transcript-view__assistant-turn');
    assert.ok(turn);
    const thoughts = turn!.querySelector('.thoughts-panel-wrap');
    const prose = turn!.querySelector('.transcript-view__assistant');
    assert.ok(thoughts && prose);
    assert.equal(
      thoughts!.compareDocumentPosition(prose!) & Node.DOCUMENT_POSITION_FOLLOWING,
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  test('reads main-chat thinking[] segments for Thoughts', () => {
    setupDom();
    const body = document.getElementById('transcriptBody')!;
    renderTranscriptView(body, [
      {
        role: 'assistant',
        content: null,
        thinking: ['First check the fixtures.', 'Then list sizes.'],
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'list_directory', arguments: '{"path":"tool-test/fixtures"}' },
          },
        ],
      },
    ]);

    assert.equal(body.querySelector('.thoughts-toggle__label')?.textContent, 'Thoughts');
    const segments = [...body.querySelectorAll('.thoughts-segment')].map((el) => el.textContent);
    assert.deepEqual(segments, ['First check the fixtures.', 'Then list sizes.']);
    const turn = body.querySelector('.transcript-view__assistant-turn');
    assert.ok(turn);
    // Thoughts + tools are siblings under the transcript body; Thoughts comes first.
    const afterTurn = turn!.nextElementSibling;
    assert.ok(afterTurn?.classList.contains('tool-call-msg'));
  });

  test('shows full multimodal user prompt text, not a single token', () => {
    setupDom();
    const body = document.getElementById('transcriptBody')!;
    renderTranscriptView(body, [
      {
        role: 'user',
        content: [
          { type: 'text', text: MULTIMODAL_PROBE_PROMPT },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ],
      },
      { role: 'assistant', content: 'A small silvery fish rests on wet wood.' },
    ]);

    const userText = body.querySelector('.transcript-view__user-text');
    assert.ok(userText);
    assert.equal(userText?.textContent, MULTIMODAL_PROBE_PROMPT);
    assert.ok(body.querySelector('.transcript-view__user-image'));
    assert.equal(
      body.querySelector('.transcript-view__assistant')?.textContent,
      'A small silvery fish rests on wet wood.',
    );
  });

  test('appends live thinking and tool indicators for in-flight sub-agent turns', () => {
    setupDom();
    const body = document.getElementById('transcriptBody')!;

    renderTranscriptView(
      body,
      [
        { role: 'user', content: 'Explore src/' },
        { role: 'assistant', content: 'Scanning the tree…' },
      ],
      {
        isLive: true,
        phase: 'tools',
        currentToolName: 'list_directory',
      },
    );

    assert.ok(body.querySelector('.transcript-view__live-tail'));
    assert.ok(body.querySelector('.tool-start-indicator'));
    assert.match(
      body.querySelector('.tool-start-indicator__label')?.textContent ?? '',
      /List Directory/i,
    );

    body.replaceChildren();
    // Live thinking with no messages yet → Thoughts toggle in the live tail.
    renderTranscriptView(body, [{ role: 'user', content: 'Go' }], {
      isLive: true,
      phase: 'thinking',
      partialReasoning: 'Need to check package.json first.',
    });

    assert.equal(
      body.querySelector('.thoughts-toggle__label')?.textContent,
      'Thinking…',
    );
    assert.ok(body.querySelector('.thoughts-panel-wrap--live'));
    assert.equal(
      body.querySelector('.thoughts-segment')?.textContent,
      'Need to check package.json first.',
    );
  });

  test('live thinking pulses message Thoughts and does not duplicate in the tail', () => {
    setupDom();
    const body = document.getElementById('transcriptBody')!;
    renderTranscriptView(
      body,
      [
        {
          role: 'assistant',
          content: '',
          reasoning: 'Need to check package.json first.',
        },
      ],
      {
        isLive: true,
        phase: 'thinking',
        partialReasoning: 'Need to check package.json first.',
      },
    );

    const toggles = body.querySelectorAll('.thoughts-toggle');
    assert.equal(toggles.length, 1);
    assert.equal(
      body.querySelector('.thoughts-toggle__label')?.textContent,
      'Thinking…',
    );
    assert.ok(body.querySelector('.thoughts-panel-wrap--live'));
    assert.equal(body.querySelector('.transcript-view__live-tail'), null);
  });

  test('stream updates grow hydrated Thoughts in place while expanded or collapsed', () => {
    setupDom();
    const body = document.getElementById('transcriptBody')!;
    const messages = [{ role: 'assistant', content: '', reasoning: 'First' }];
    renderTranscriptView(body, messages, {
      isLive: true, phase: 'thinking', partialReasoning: 'First',
    });
    const toggle = body.querySelector<HTMLElement>('.thoughts-toggle')!;
    toggle.click();

    for (const expanded of [true, false]) {
      const reasoning = expanded ? 'First, inspect the code.' : 'First, inspect the code. Then test.';
      appendTranscriptLiveTail(body, {
        isLive: true, phase: 'thinking', partialReasoning: reasoning,
      }, messages);
      assert.equal(body.querySelector('.thoughts-toggle'), toggle);
      assert.equal(toggle.getAttribute('aria-expanded'), String(expanded));
      assert.equal(body.querySelector('.thoughts-segment')?.textContent, reasoning);
      assert.equal(body.querySelectorAll('.thoughts-toggle').length, 1);
      if (expanded) toggle.click();
    }
  });

  test('subAgentTranscriptLiveFromRun maps orchestrator live fields', () => {
    const live = subAgentTranscriptLiveFromRun(
      {
        runId: 'run-1',
        type: 'explore',
        task: 't',
        status: 'running',
        parentChatId: 'chat-1',
        parentToolCallId: null,
        parentTurnId: null,
        summary: '',
        error: null,
        startedAt: null,
        endedAt: null,
        toolTurns: 0,
        cancelled: false,
        messages: [],
        livePhase: 'generating',
      },
      true,
    );
    assert.equal(live?.phase, 'generating');
    assert.equal(live?.isLive, true);
  });

  test('generating live tail paints partial prose so the row is not empty', () => {
    setupDom();
    const body = document.getElementById('transcriptBody')!;
    renderTranscriptView(body, [{ role: 'user', content: 'Explore src/' }], {
      isLive: true,
      phase: 'generating',
      partialText: 'Here is what I found in src/.',
    });
    assert.ok(body.querySelector('.stream-status--generating'));
    assert.match(body.textContent ?? '', /Generating response/);
    const partial = body.querySelector('.transcript-view__assistant--partial');
    assert.ok(partial);
    assert.equal(partial?.textContent, 'Here is what I found in src/.');
  });

  test('growing live thinking keeps the same collapsed Thoughts toggle', () => {
    setupDom();
    const body = document.getElementById('transcriptBody')!;
    renderTranscriptView(body, [{ role: 'user', content: 'Go' }], {
      isLive: true,
      phase: 'thinking',
      partialReasoning: 'Need to check',
    });
    const toggle = body.querySelector('.thoughts-toggle');
    const caret = body.querySelector('.thoughts-caret');
    assert.ok(toggle);
    assert.equal(toggle?.getAttribute('aria-expanded'), 'false');

    appendTranscriptLiveTail(
      body,
      {
        isLive: true,
        phase: 'thinking',
        partialReasoning: 'Need to check package.json first.',
      },
      [{ role: 'user', content: 'Go' }],
    );

    assert.equal(body.querySelector('.thoughts-toggle'), toggle);
    assert.equal(body.querySelector('.thoughts-caret'), caret);
    assert.equal(toggle?.getAttribute('aria-expanded'), 'false');
    assert.equal(
      body.querySelector('.thoughts-segment')?.textContent,
      'Need to check package.json first.',
    );
  });

  test('mid-chain thinking grows on a row painted without the live pulse', () => {
    setupDom();
    const body = document.getElementById('transcriptBody')!;
    // The board paints its thread and only afterwards patches streaming
    // activity, so the mounted panel carries no --live marker.
    const messages = [{ role: 'assistant', content: '', reasoning: 'Need to check' }];
    renderTranscriptView(body, messages);
    assert.equal(body.querySelector('.thoughts-panel-wrap--live'), null);
    const toggle = body.querySelector('.thoughts-toggle');

    appendTranscriptLiveTail(
      body,
      { isLive: true, phase: 'thinking', partialReasoning: 'Need to check package.json first.' },
      messages,
    );

    assert.equal(body.querySelector('.thoughts-toggle'), toggle);
    assert.equal(
      body.querySelector('.thoughts-segment')?.textContent,
      'Need to check package.json first.',
    );
    assert.equal(body.querySelector('.transcript-view__live-tail'), null);
  });

  test('growing the open thought leaves earlier thoughts of the turn intact', () => {
    setupDom();
    const body = document.getElementById('transcriptBody')!;
    const messages = [
      { role: 'assistant', content: '', reasoning: 'Read the file.\n\nNow decide' },
    ];
    renderTranscriptView(body, messages, {
      isLive: true, phase: 'thinking', partialReasoning: 'Now decide',
    });

    appendTranscriptLiveTail(
      body,
      { isLive: true, phase: 'thinking', partialReasoning: 'Now decide what to change.' },
      messages,
    );

    const segments = [...body.querySelectorAll('.thoughts-segment')].map((s) => s.textContent);
    assert.deepEqual(segments, ['Read the file.', 'Now decide what to change.']);
  });

  test('live tail remounts when the phase changes from thinking to tools', () => {
    setupDom();
    const body = document.getElementById('transcriptBody')!;
    renderTranscriptView(body, [{ role: 'user', content: 'Go' }], {
      isLive: true,
      phase: 'thinking',
      partialReasoning: 'Need to check package.json first.',
    });
    const toggle = body.querySelector('.thoughts-toggle');
    assert.ok(toggle);

    appendTranscriptLiveTail(
      body,
      {
        isLive: true,
        phase: 'tools',
        currentToolName: 'read_file',
      },
      [{ role: 'user', content: 'Go' }],
    );

    assert.equal(body.querySelector('.thoughts-toggle'), null);
    assert.ok(body.querySelector('.tool-start-indicator'));
    assert.match(
      body.querySelector('.tool-start-indicator__label')?.textContent ?? '',
      /Read/i,
    );
  });
});
