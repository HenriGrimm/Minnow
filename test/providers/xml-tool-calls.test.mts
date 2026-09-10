/**
 * XML-tagged tool calls in assistant content (Qwen via mlx-lm / llama.cpp).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ContentToolCallRouter,
  hasXmlToolCallMarkup,
  stripXmlToolCallBlocks,
  tryParseXmlToolCallsFromText,
} from '../../src/providers/xml-tool-calls.ts';
import { mergeContentJsonToolCalls } from '../../src/providers/constrained-tool-content.ts';
import {
  InlineContentThinkingRouter,
  modelLikelyUsesInlineThinking,
} from '../../src/api/inline-thinking.ts';
import type { ToolCall } from '../../src/types';

const READ_FILE = '<tool_call>\n{"name": "read_file", "arguments": {"path": "src/a.ts"}}\n</tool_call>';

function streamThrough(router: ContentToolCallRouter, chunks: readonly string[]): string {
  let prose = '';
  for (const chunk of chunks) {
    prose += router.feed(chunk);
  }
  return prose + router.flush();
}

describe('tryParseXmlToolCallsFromText', () => {
  test('parses a Qwen XML function/parameter envelope', () => {
    const xml = `<tool_call>
<function=read_file>
<parameter=path>
src/a.ts
</parameter>
</function>
</tool_call>`;
    const calls = tryParseXmlToolCallsFromText(xml);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'read_file');
    assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: 'src/a.ts' });
  });

  test('parses Qwen XML with JSON parameter values and missing close tags', () => {
    const xml = `<tool_call>
<function=save_file>
<parameter=path>
out.json
</parameter>
<parameter=content>
{"ok":true}
`;
    const calls = tryParseXmlToolCallsFromText(xml);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'save_file');
    assert.deepEqual(JSON.parse(calls[0].function.arguments), {
      path: 'out.json',
      content: { ok: true },
    });
  });

  test('a missing close tag on a non-final parameter does not swallow the rest', () => {
    // Models routinely omit `</parameter>` entirely. Every parameter must still
    // land as its own key: when the first one absorbs the remaining markup, the
    // call arrives with a single key and the tool rejects it as malformed.
    const xml = `<tool_call>
<function=report_outcome>
<parameter=outcome>
pass
<parameter=summary>
W1-A verified.
<parameter=blockers>
[]
</function>
</tool_call>`;
    const calls = tryParseXmlToolCallsFromText(xml);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'report_outcome');
    assert.deepEqual(JSON.parse(calls[0].function.arguments), {
      outcome: 'pass',
      summary: 'W1-A verified.',
      blockers: [],
    });
  });

  test('parses an envelope that closes some parameters and not others', () => {
    const xml = `<tool_call>
<function=save_file>
<parameter=path>
out.json
</parameter>
<parameter=content>
{"ok":true}
</function>
</tool_call>`;
    const calls = tryParseXmlToolCallsFromText(xml);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].function.arguments), {
      path: 'out.json',
      content: { ok: true },
    });
  });

  test('parses a bare Qwen <function=name> block without a wrapping tool_call tag', () => {
    const calls = tryParseXmlToolCallsFromText(
      '<function=get_datetime>\n<parameter=ignored>\n\n</parameter>\n</function>',
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'get_datetime');
  });

  test('recovers unwrapped JSON after Qwen <function=name> as tool arguments', () => {
    const xml = `<function=todo_write>
{"todos":[{"text":"a","status":"in_progress"}]}
</function>`;
    const calls = tryParseXmlToolCallsFromText(xml);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'todo_write');
    assert.deepEqual(JSON.parse(calls[0].function.arguments), {
      todos: [{ text: 'a', status: 'in_progress' }],
    });
  });

  test('recovers unwrapped todo_write JSON inside a tool_call wrapper', () => {
    const xml = `<tool_call>
<function=todo_write>
{"todos":[{"text":"a","status":"in_progress"}]}
</function>
</tool_call>`;
    const calls = tryParseXmlToolCallsFromText(xml);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'todo_write');
    const args = JSON.parse(calls[0].function.arguments);
    assert.notDeepEqual(args, {});
    assert.deepEqual(args, {
      todos: [{ text: 'a', status: 'in_progress' }],
    });
  });

  test('parses several blocks and drops duplicates', () => {
    const calls = tryParseXmlToolCallsFromText(
      `${READ_FILE}\n${READ_FILE}\n<tool_use>{"name":"grep","parameters":{"q":"foo"}}</tool_use>`,
    );
    assert.deepEqual(
      calls.map((call) => call.function.name),
      ['read_file', 'grep'],
    );
    assert.deepEqual(JSON.parse(calls[1].function.arguments), { q: 'foo' });
  });

  test('parses a block whose closing tag never arrived', () => {
    const calls = tryParseXmlToolCallsFromText('<tool_call>\n{"name":"read_file","arguments":{}}');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'read_file');
  });

  test('ignores prose and malformed payloads', () => {
    assert.deepEqual(tryParseXmlToolCallsFromText('Just a reply about <tool_call> tags.'), []);
    assert.deepEqual(tryParseXmlToolCallsFromText('<tool_call>not json</tool_call>'), []);
    assert.deepEqual(tryParseXmlToolCallsFromText('<tool_call>{"arguments":{}}</tool_call>'), []);
    assert.equal(hasXmlToolCallMarkup('plain reply'), false);
  });

  test('strips blocks from prose', () => {
    assert.equal(stripXmlToolCallBlocks(`Reading it.\n${READ_FILE}`), 'Reading it.');
  });
});

describe('ContentToolCallRouter', () => {
  test('withholds a Qwen XML envelope from visible text', () => {
    const router = new ContentToolCallRouter();
    const xml =
      '<tool_call>\n<function=read_file>\n<parameter=path>\na.ts\n</parameter>\n</function>\n</tool_call>';
    const prose = streamThrough(router, ['I will read it.\n', xml]);
    assert.equal(prose, 'I will read it.\n');
    assert.equal(tryParseXmlToolCallsFromText(router.getToolCallParseText()).length, 1);
    assert.equal(router.peekStreamingToolName(), 'read_file');
  });

  test('peekStreamingToolName names a JSON call before the close tag arrives', () => {
    const router = new ContentToolCallRouter();
    router.feed('<tool_call>{"name":"grep","arguments":{"q":');
    assert.equal(router.peekStreamingToolName(), 'grep');
    assert.equal(router.hasCapturedToolCalls(), false);
  });

  test('handles tags split across deltas', () => {
    const router = new ContentToolCallRouter();
    const prose = streamThrough(router, [
      'Reading.',
      '<tool',
      '_call>{"name":"read_file",',
      '"arguments":{"path":"a.ts"}}</tool',
      '_call>',
    ]);
    assert.equal(prose, 'Reading.');
    const calls = tryParseXmlToolCallsFromText(router.getToolCallParseText());
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: 'a.ts' });
  });

  test('captures an unterminated block instead of leaking it as prose', () => {
    const router = new ContentToolCallRouter();
    const prose = streamThrough(router, ['<tool_call>{"name":"read_file","arguments":{}}']);
    assert.equal(prose, '');
    assert.equal(tryParseXmlToolCallsFromText(router.getToolCallParseText()).length, 1);
  });

  test('passes ordinary prose through untouched, including angle brackets', () => {
    const router = new ContentToolCallRouter();
    const prose = streamThrough(router, ['Use <div> when a < b', ' and </tool', 'tip> is fine.']);
    assert.equal(prose, 'Use <div> when a < b and </tooltip> is fine.');
    assert.equal(router.hasCapturedToolCalls(), false);
  });

  test('keeps non-tool-call markup visible (model explaining the format)', () => {
    const router = new ContentToolCallRouter();
    const prose = streamThrough(router, [
      'Qwen emits `<tool_call>',
      '{ "name": ... }',
      '</tool_call>` blocks.',
    ]);
    assert.equal(prose, 'Qwen emits `<tool_call>{ "name": ... }</tool_call>` blocks.');
    assert.equal(router.hasCapturedToolCalls(), false);
  });

  test('closes an unterminated block when the next opener arrives', () => {
    const router = new ContentToolCallRouter();
    streamThrough(router, [
      '<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}',
      '<tool_call>{"name":"grep","arguments":{"q":"x"}}</tool_call>',
    ]);
    assert.deepEqual(
      tryParseXmlToolCallsFromText(router.getToolCallParseText()).map((c) => c.function.name),
      ['read_file', 'grep'],
    );
  });
});

describe('mergeContentJsonToolCalls with xmlParseText', () => {
  test('recovers tool calls when SSE tool_calls were empty', () => {
    const calls = mergeContentJsonToolCalls('', [], { xmlParseText: READ_FILE });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'read_file');
  });

  test('parses blocks left in content when nothing routed them', () => {
    const calls = mergeContentJsonToolCalls(`Reading.\n${READ_FILE}`, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'read_file');
  });

  test('keeps streamed tool calls but fills empty arguments from content', () => {
    const streamed = [
      { id: 'call_1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } },
    ];
    const calls = mergeContentJsonToolCalls('', streamed, { xmlParseText: READ_FILE });
    assert.equal(calls[0].id, 'call_1');
    assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: 'src/a.ts' });
  });

  test('leaves plain replies without tool calls', () => {
    assert.deepEqual(mergeContentJsonToolCalls('Hello there.', []), []);
  });
});

/**
 * Two-channel stream pipeline as `streamCompletionTurn` wires it: inline-thinking split
 * first, then a `<tool_call>` capture on each side. Qwen3.8 interleaved thinking emits the
 * call *before* `</think>`, so the thinking-side capture is what keeps the tool running.
 */
function streamTwoChannel(
  chunks: readonly string[],
  streamed: ToolCall[] = [],
): { thinking: string; prose: string; calls: readonly string[] } {
  const inline = new InlineContentThinkingRouter({
    thinkingModel: modelLikelyUsesInlineThinking('Qwen3.8-27B-Q4_K_M'),
  });
  const prose = new ContentToolCallRouter();
  const thinkingTools = new ContentToolCallRouter();
  let thinkingText = '';
  let proseText = '';
  const route = (parts: readonly (readonly [string, boolean])[]): void => {
    for (const [text, isThinking] of parts) {
      if (isThinking) {
        thinkingText += thinkingTools.feed(text);
        continue;
      }
      if (!text) continue;
      proseText += prose.feed(text);
    }
  };
  for (const chunk of chunks) {
    route(inline.feed(chunk));
  }
  route(inline.flush());
  thinkingText += thinkingTools.flush();
  proseText += prose.flush();
  const calls = mergeContentJsonToolCalls(proseText, streamed, {
    xmlParseText: prose.getToolCallParseText(),
    thinkingXmlParseText: thinkingTools.getToolCallParseText(),
  });
  return { thinking: thinkingText, prose: proseText, calls: calls.map((c) => c.function.name) };
}

/**
 * Native `reasoning_content` (MTPLX / DeepSeek): the think span is already split
 * by the server, so there is no `<think>` wrapper — only the reasoning channel.
 */
function streamNativeReasoning(
  chunks: readonly string[],
): { thinking: string; calls: readonly string[] } {
  const thinkingTools = new ContentToolCallRouter();
  let thinkingText = '';
  for (const chunk of chunks) {
    thinkingText += thinkingTools.feed(chunk);
  }
  thinkingText += thinkingTools.flush();
  const calls = mergeContentJsonToolCalls('', [], {
    thinkingXmlParseText: [thinkingTools.getToolCallParseText(), thinkingText].join('\n'),
  });
  return { thinking: thinkingText, calls: calls.map((c) => c.function.name) };
}

describe('tool calls emitted inside a think span', () => {
  test('runs the call and keeps the markup out of the thinking bubble', () => {
    const out = streamTwoChannel([
      '<think>',
      'I should read the file.',
      READ_FILE,
      '</think>',
      'Done.',
    ]);
    assert.deepEqual(out.calls, ['read_file']);
    assert.equal(out.thinking.includes('tool_call'), false);
    assert.equal(out.prose, 'Done.');
  });

  test('runs the call when `</think>` never arrives', () => {
    const out = streamTwoChannel(['<think>', 'Reading it now.', READ_FILE]);
    assert.deepEqual(out.calls, ['read_file']);
    assert.equal(out.thinking, 'Reading it now.');
  });

  test('runs the call when the tags are split across deltas', () => {
    const out = streamTwoChannel([
      '<think>',
      'reasoning',
      '<tool',
      '_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool',
      '_call>',
      '</think>',
    ]);
    assert.deepEqual(out.calls, ['read_file']);
    assert.equal(out.thinking, 'reasoning');
  });

  test('leaves reasoning that only discusses the format alone', () => {
    const out = streamTwoChannel([
      '<think>',
      'Qwen emits <tool_call>{ "name": ... }</tool_call> blocks.',
      '</think>',
      'Here is the answer.',
    ]);
    assert.deepEqual(out.calls, []);
    assert.equal(out.thinking, 'Qwen emits <tool_call>{ "name": ... }</tool_call> blocks.');
  });

  test('never rewrites streamed tool calls from a draft left in thinking', () => {
    const streamed: ToolCall[] = [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"real.ts"}' },
      },
    ];
    const out = streamTwoChannel(['<think>', READ_FILE, '</think>'], streamed);
    assert.deepEqual(out.calls, ['read_file']);
  });

  test('runs a tool call inside a second think span after prose', () => {
    const out = streamTwoChannel([
      '<think>',
      'plan',
      '</think>',
      'Working.',
      '<think>',
      'now call',
      READ_FILE,
      '</think>',
    ]);
    assert.deepEqual(out.calls, ['read_file']);
    assert.equal(out.prose, 'Working.');
    assert.equal(out.thinking.includes('tool_call'), false);
    assert.match(out.thinking, /plan/);
    assert.match(out.thinking, /now call/);
  });
});

describe('tool calls on the native reasoning channel', () => {
  test('runs a JSON tool_call that arrived as reasoning_content (MTPLX)', () => {
    const out = streamNativeReasoning([
      'I should read the file.\n',
      READ_FILE,
    ]);
    assert.deepEqual(out.calls, ['read_file']);
    assert.equal(out.thinking.includes('tool_call'), false);
    assert.match(out.thinking, /I should read the file/);
  });

  test('runs a Qwen XML envelope that arrived as reasoning_content', () => {
    const out = streamNativeReasoning([
      'Need the clock.\n',
      '<tool_call>\n<function=get_datetime>\n</function>\n</tool_call>',
    ]);
    assert.deepEqual(out.calls, ['get_datetime']);
    assert.equal(out.thinking.includes('tool_call'), false);
    assert.equal(out.thinking.includes('function='), false);
    assert.match(out.thinking, /Need the clock/);
  });
});

describe('mergeContentJsonToolCalls with thinkingXmlParseText', () => {
  test('is a last-resort fallback behind prose markup', () => {
    const calls = mergeContentJsonToolCalls('', [], {
      xmlParseText: READ_FILE,
      thinkingXmlParseText: '<tool_call>{"name":"grep","arguments":{"q":"x"}}</tool_call>',
    });
    assert.deepEqual(
      calls.map((call) => call.function.name),
      ['read_file'],
    );
  });

  test('never enriches streamed arguments from thinking', () => {
    const streamed = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'read_file', arguments: '{"path":"real.ts"}' },
      },
    ];
    const calls = mergeContentJsonToolCalls('', streamed, { thinkingXmlParseText: READ_FILE });
    assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: 'real.ts' });
  });
});
