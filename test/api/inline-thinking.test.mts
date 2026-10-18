/**
 * Inline thinking extraction and stream routing (MiniMax, Qwen, Gemma, gpt-oss).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  extractInlineThinkingFromContent,
  HarmonyChannelRouter,
  InlineContentThinkingRouter,
  normalizeThinkingMarkup,
  type RoutedContentPart,
} from '../../src/api/inline-thinking.ts';
import { extractReasoningDelta } from '../../src/api/reasoning.ts';

const RT_OPEN = '<' + 'redacted_thinking>';
const RT_CLOSE = '</' + 'redacted_thinking>';
const THINK_OPEN = '<' + 'think>';
const THINK_CLOSE = '</' + 'think>';

function collectRouted(router: InlineContentThinkingRouter, chunks: readonly string[]): RoutedContentPart[] {
  const parts: RoutedContentPart[] = [];
  for (const chunk of chunks) {
    parts.push(...router.feed(chunk));
  }
  parts.push(...router.flush());
  return parts;
}

function thinkingText(parts: readonly RoutedContentPart[]): string {
  return parts
    .filter(([, isThinking]) => isThinking)
    .map(([text]) => text)
    .join('');
}

function replyText(parts: readonly RoutedContentPart[]): string {
  return parts
    .filter(([, isThinking]) => !isThinking)
    .map(([text]) => text)
    .join('');
}

describe('extractInlineThinkingFromContent', () => {
  test('MiniMax sample splits reasoning prose from reply', () => {
    const input =
      'The user just sent "test". … I shouldn\'t use save_memory …\n\nWorking. What can I help you with?';
    const split = extractInlineThinkingFromContent(input);
    assert.equal(split.thinking.length, 1);
    assert.match(split.thinking[0], /The user just sent/);
    assert.match(split.thinking[0], /save_memory/);
    assert.equal(split.reply, 'Working. What can I help you with?');
  });

  test('tagged redacted_thinking block', () => {
    const input = `${RT_OPEN}reasoning here${RT_CLOSE}\n\nHello`;
    const split = extractInlineThinkingFromContent(input);
    assert.deepEqual(split.thinking, ['reasoning here']);
    assert.equal(split.reply, 'Hello');
  });

  test('Thinking Process prefix (Qwen3.5-style)', () => {
    const input = 'Thinking Process: I need to answer this.\n\nHello there!';
    const split = extractInlineThinkingFromContent(input);
    assert.deepEqual(split.thinking, ['I need to answer this.']);
    assert.equal(split.reply, 'Hello there!');
  });

  test('Gemma-style untagged reasoning paragraph', () => {
    const input = 'The user asked about cats.\n\nHello!';
    const split = extractInlineThinkingFromContent(input);
    assert.deepEqual(split.thinking, ['The user asked about cats.']);
    assert.equal(split.reply, 'Hello!');
  });

  test('reasoning-only turn stays intact', () => {
    const input = 'The user wants help with Python. I should explain clearly.';
    const split = extractInlineThinkingFromContent(input);
    assert.deepEqual(split.thinking, []);
    assert.equal(split.reply, input);
  });

  test('prose-only instruct model is not split', () => {
    const input = 'Here is your answer about local LLM inference.';
    const split = extractInlineThinkingFromContent(input);
    assert.deepEqual(split.thinking, []);
    assert.equal(split.reply, input);
  });
});

describe('normalizeThinkingMarkup / Gemma channels', () => {
  test('Gemma thought and response channel wrappers', () => {
    const input =
      '<|channel>thought\ninternal reasoning<channel|>\n<|channel>response\nHello user!<channel|>';
    const normalized = normalizeThinkingMarkup(input);
    assert.match(normalized, /internal reasoning/);
    assert.match(normalized, /Hello user!/);
    const split = extractInlineThinkingFromContent(input);
    assert.deepEqual(split.thinking, ['internal reasoning']);
    assert.equal(split.reply, 'Hello user!');
  });
});

describe('InlineContentThinkingRouter', () => {
  test('stray closing tag without opener (MiniMax quirk)', () => {
    const router = new InlineContentThinkingRouter({ thinkingModel: true });
    const parts = collectRouted(router, ['The user wants help' + RT_CLOSE + '\n\nHello']);
    assert.equal(thinkingText(parts), 'The user wants help');
    assert.equal(replyText(parts).trim(), 'Hello');
  });

  test('streams partial open/close tags across chunk boundaries', () => {
    const router = new InlineContentThinkingRouter({ thinkingModel: true });
    const parts = collectRouted(router, [
      RT_OPEN.slice(0, 12),
      RT_OPEN.slice(12) + 'reason',
      'ing' + RT_CLOSE + '\n\nHi!',
    ]);
    assert.equal(thinkingText(parts), 'reasoning');
    assert.match(replyText(parts), /Hi!/);
  });

  for (const thinkingModel of [false, true]) {
    test(`routes a plain <think> block (thinkingModel=${thinkingModel})`, () => {
      const router = new InlineContentThinkingRouter({ thinkingModel });
      const parts = collectRouted(router, [THINK_OPEN, 'reasoning ', THINK_CLOSE, 'Hi!']);
      assert.equal(thinkingText(parts), 'reasoning ');
      assert.equal(replyText(parts), 'Hi!');
    });

    // mlx-lm splits `</think>` across SSE deltas; an unmatched close used to keep
    // every later delta — tool-call markup included — routed as reasoning.
    test(`closes thinking when </think> is split across deltas (thinkingModel=${thinkingModel})`, () => {
      const router = new InlineContentThinkingRouter({ thinkingModel });
      const parts = collectRouted(router, [
        THINK_OPEN,
        'reasoning ',
        THINK_CLOSE.slice(0, 4),
        THINK_CLOSE.slice(4),
        'Hi!',
      ]);
      assert.equal(thinkingText(parts), 'reasoning ');
      assert.equal(replyText(parts), 'Hi!');
    });

    test(`routes think tags streamed one character at a time (thinkingModel=${thinkingModel})`, () => {
      const router = new InlineContentThinkingRouter({ thinkingModel });
      const parts = collectRouted(router, [...`${THINK_OPEN}reasoning${THINK_CLOSE}Hi!`]);
      assert.equal(thinkingText(parts), 'reasoning');
      assert.equal(replyText(parts), 'Hi!');
    });
  }

  test('keeps a lone < in prose instead of holding it back', () => {
    const router = new InlineContentThinkingRouter({ thinkingModel: true });
    const parts = collectRouted(router, [THINK_OPEN, 'x', THINK_CLOSE, 'a < b and <div>']);
    assert.equal(replyText(parts), 'a < b and <div>');
  });

  test('releases an incomplete opener left at end of stream', () => {
    const router = new InlineContentThinkingRouter({ thinkingModel: true });
    const parts = collectRouted(router, ['Done.', ' <thi']);
    assert.equal(thinkingText(parts), '');
    assert.equal(replyText(parts), 'Done. <thi');
  });

  // Interleaved-thinking models (Qwen3.8) emit think → prose → think again.
  // The second opener used to leak into the visible reply because the router
  // only entered a think span while firstContentSent was false.
  test('routes a second <think> span after visible prose', () => {
    const router = new InlineContentThinkingRouter({ thinkingModel: true });
    const parts = collectRouted(router, [
      THINK_OPEN,
      'plan',
      THINK_CLOSE,
      'Working.',
      THINK_OPEN,
      'now call',
      THINK_CLOSE,
    ]);
    assert.equal(thinkingText(parts), 'plannow call');
    assert.equal(replyText(parts), 'Working.');
  });

  test('routes a second think span that starts on its own line in one chunk', () => {
    const router = new InlineContentThinkingRouter({ thinkingModel: true });
    const parts = collectRouted(router, [
      `${THINK_OPEN}plan${THINK_CLOSE}Working.\n${THINK_OPEN}now call${THINK_CLOSE}`,
    ]);
    assert.equal(thinkingText(parts), 'plannow call');
    assert.equal(replyText(parts), 'Working.\n');
  });

  test('closes a second think span when </think> is split across deltas', () => {
    const router = new InlineContentThinkingRouter({ thinkingModel: true });
    const parts = collectRouted(router, [
      THINK_OPEN,
      'plan',
      THINK_CLOSE,
      'Working.',
      THINK_OPEN,
      'now call',
      THINK_CLOSE.slice(0, 4),
      THINK_CLOSE.slice(4),
    ]);
    assert.equal(thinkingText(parts), 'plannow call');
    assert.equal(replyText(parts), 'Working.');
  });

  test('routes a second think span streamed one character at a time', () => {
    const router = new InlineContentThinkingRouter({ thinkingModel: true });
    const parts = collectRouted(router, [
      ...`${THINK_OPEN}plan${THINK_CLOSE}Working.${THINK_OPEN}now call${THINK_CLOSE}`,
    ]);
    assert.equal(thinkingText(parts), 'plannow call');
    assert.equal(replyText(parts), 'Working.');
  });

  test('does not reclassify a <think> mention glued to prose', () => {
    const router = new InlineContentThinkingRouter({ thinkingModel: true });
    const sample = `Working. Use the ${THINK_OPEN} tag in examples ${THINK_CLOSE} like this.`;
    const parts = collectRouted(router, [THINK_OPEN, 'plan', THINK_CLOSE, sample]);
    assert.equal(thinkingText(parts), 'plan');
    assert.equal(replyText(parts), sample);
  });

  test('does not re-enter think mode on an instruct model after prose', () => {
    const router = new InlineContentThinkingRouter({ thinkingModel: false });
    const parts = collectRouted(router, [
      'Here is a sample:\n',
      THINK_OPEN,
      'example',
      THINK_CLOSE,
    ]);
    assert.equal(thinkingText(parts), '');
    assert.match(replyText(parts), /Here is a sample/);
    assert.match(replyText(parts), /example/);
  });

  test('holds a second think span as prose until the matching close arrives', () => {
    const router = new InlineContentThinkingRouter({ thinkingModel: true });
    const parts = collectRouted(router, [
      THINK_OPEN,
      'plan',
      THINK_CLOSE,
      'Working.',
      THINK_OPEN,
      'now call',
    ]);
    assert.equal(thinkingText(parts), 'plan');
    assert.equal(replyText(parts), `Working.${THINK_OPEN}now call`);
  });
});

describe('HarmonyChannelRouter', () => {
  test('routes gpt-oss analysis vs final channels', () => {
    const router = new HarmonyChannelRouter();
    const parts = [
      ...router.feed('<|channel|>analysis<|message|>thinking here'),
      ...router.feed('<|channel|>final<|message|>visible reply'),
      ...router.flush(),
    ];
    assert.equal(thinkingText(parts), 'thinking here');
    assert.equal(replyText(parts), 'visible reply');
  });

  test('suppresses commentary tool-call channel from visible prose', () => {
    const router = new HarmonyChannelRouter();
    const parts = [
      ...router.feed('<|channel|>commentary to=functions.list_directory '),
      ...router.feed('code{ "path": "." }'),
      ...router.feed('<|channel|>final<|message|>Listing the workspace.'),
      ...router.flush(),
    ];
    assert.equal(replyText(parts), 'Listing the workspace.');
    assert.match(router.getCommentaryParseText(), /to=functions\.list_directory/);
    assert.match(router.getCommentaryParseText(), /"path":\s*"\.\s*"/);
  });
});

describe('extractReasoningDelta', () => {
  test('reads delta.thinking SSE field', () => {
    const text = extractReasoningDelta({
      choices: [{ delta: { thinking: 'step one' } }],
    });
    assert.equal(text, 'step one');
  });
});


test('Harmony progress waits for a complete recipient and follows each tool header', () => {
  const router = new HarmonyChannelRouter();
  router.feed('<|channel|>commentary to=functions.read_');
  assert.equal(router.peekStreamingToolName(), '');
  router.feed('file<|message|>{"path":"a"}<|call|>');
  assert.equal(router.peekStreamingToolName(), 'read_file');
  router.feed('<|channel|>commentary to=functions.grep ');
  assert.equal(router.peekStreamingToolName(), 'grep');
  assert.equal((router.getCommentaryParseText().match(/<\|channel\|>commentary/g) ?? []).length, 2);
});
