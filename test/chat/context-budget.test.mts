/**
 * Context budget enforcement (MIN-39).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyContextBudget,
  estimateApiMessageTokens,
  estimateApiMessagesTokens,
  formatContextTrimStatus,
  LOCAL_MIN_GENERATION_TOKENS,
  LOCAL_PROMPT_FLOOR_TOKENS,
  localGenerationReserveTokens,
  partitionTurns,
  resolveContextBudget,
  resolveLocalWindowReserves,
  SAFETY_MARGIN,
} from '../../src/chat/context-budget.ts';
import { ESTIMATE_IMAGE_URL_TOKENS } from '../../src/chat/prompts/token-estimate-core.ts';
import type { ApiMessage, ToolCall } from '../../src/types.ts';

function user(content: string): ApiMessage {
  return { role: 'user', content };
}

function assistant(content: string): ApiMessage {
  return { role: 'assistant', content };
}

function system(content: string): ApiMessage {
  return { role: 'system', content };
}

function toolResult(id: string, content: string): ApiMessage {
  return { role: 'tool', tool_call_id: id, content };
}

function assistantWithTools(content: string | null, toolCalls: ToolCall[]): ApiMessage {
  return {
    role: 'assistant',
    content,
    tool_calls: toolCalls,
  };
}

// ── resolveContextBudget ─────────────────────────────────────────────────────

describe('resolveContextBudget', () => {
  test('effectiveLimit is 90% of model limit', () => {
    const resolved = resolveContextBudget({
      agentConfig: { enforcementPolicy: 'slide' },
      modelLimit: 32000,
    });
    assert.equal(resolved.modelLimit, 32000);
    assert.equal(resolved.effectiveLimit, 28800);
  });

  test('unknown model limit yields no effective limit', () => {
    const resolved = resolveContextBudget({
      agentConfig: { enforcementPolicy: 'slide' },
      modelLimit: null,
    });
    assert.equal(resolved.effectiveLimit, null);
  });

  test('reserved tokens come out of the message ceiling', () => {
    const resolved = resolveContextBudget({
      agentConfig: { enforcementPolicy: 'slide' },
      modelLimit: 32000,
      reservedTokens: 4000,
    });
    assert.equal(resolved.effectiveLimit, 24800);
    assert.equal(resolved.reservedTokens, 4000);
  });

  test('messages plus reserve always fit inside the model window', () => {
    // The bug this guards: tool schemas ride in `body.tools`, outside the
    // message estimate, so an unreserved budget authorised more than the
    // window could hold and the server rejected the send.
    for (const reserve of [0, 1200, 12048, 40000]) {
      const resolved = resolveContextBudget({
        agentConfig: { enforcementPolicy: 'summarize' },
        modelLimit: 89088,
        reservedTokens: reserve,
      });
      assert.ok(resolved.effectiveLimit! + reserve <= 89088 * SAFETY_MARGIN + 1);
    }
  });

  test('a reserve larger than the window still leaves a usable ceiling', () => {
    const resolved = resolveContextBudget({
      agentConfig: { enforcementPolicy: 'slide' },
      modelLimit: 4096,
      reservedTokens: 999999,
    });
    assert.equal(resolved.effectiveLimit, 1);
  });

  test('32k window plus 32k maxTokens still leaves a multi-thousand-token message ceiling', () => {
    // Generation leftover caps max_tokens; it must not shrink the message budget.
    const toolsReserve = 1200;
    for (const providerId of ['llama-cpp-local', 'mlx-lm-local'] as const) {
      const window = resolveLocalWindowReserves({
        providerId,
        maxTokens: 32768,
        modelLimit: 32768,
        toolsReserveTokens: toolsReserve,
      });
      assert.equal(window.reservedTokens, toolsReserve);
      const resolved = resolveContextBudget({
        agentConfig: { enforcementPolicy: 'summarize' },
        modelLimit: 32768,
        reservedTokens: window.reservedTokens,
      });
      assert.ok(
        resolved.effectiveLimit! >= LOCAL_PROMPT_FLOOR_TOKENS,
        `${providerId} message ceiling ${resolved.effectiveLimit} should stay at the prompt floor`,
      );
      assert.ok(window.requestMaxTokens <= 32768);
      assert.ok(window.requestMaxTokens < 32768);
      assert.ok(
        resolved.effectiveLimit! + window.reservedTokens
          <= Math.floor(32768 * SAFETY_MARGIN) + 1,
      );
    }
  });

  test('70k window plus 32k maxTokens does not tax a 20k-token prompt as over budget', () => {
    // The regression after the first reserve cap: floor was system+last-user
    // (or 4096), so a 70k serve still reserved the full Settings 32k and a
    // normal Minnow system+history estimate looked "over" while the wheel
    // still showed plenty of room.
    const messages = [
      { role: 'system' as const, content: 's'.repeat(120_000) },
      { role: 'assistant' as const, content: 'a'.repeat(20_000) },
      { role: 'user' as const, content: 'hello again' },
    ];
    const toolsReserve = 12_000;
    const prompt = estimateApiMessagesTokens(messages);
    const window = resolveLocalWindowReserves({
      providerId: 'llama-cpp-local',
      maxTokens: 32768,
      modelLimit: 70_000,
      toolsReserveTokens: toolsReserve,
      messages,
    });
    const resolved = resolveContextBudget({
      agentConfig: { enforcementPolicy: 'summarize' },
      modelLimit: 70_000,
      reservedTokens: window.reservedTokens,
    });
    assert.ok(prompt > 20_000, `fixture prompt should be bulky, got ${prompt}`);
    assert.equal(window.reservedTokens, toolsReserve);
    assert.ok(
      prompt <= (resolved.effectiveLimit ?? 0),
      `prompt ${prompt} must fit message ceiling ${resolved.effectiveLimit}`,
    );
    assert.ok(window.requestMaxTokens >= 1);
    assert.ok(window.requestMaxTokens <= 32768);
  });

  test('unknown local n_ctx does not reserve Settings maxTokens', () => {
    assert.equal(
      localGenerationReserveTokens({
        providerId: 'llama-cpp-local',
        maxTokens: 32768,
        modelLimit: null,
        toolsReserveTokens: 0,
      }),
      0,
    );
  });

  test('cloud providers do not reserve generation tokens against n_ctx', () => {
    assert.equal(
      localGenerationReserveTokens({
        providerId: 'openai',
        maxTokens: 32768,
        modelLimit: 32768,
        toolsReserveTokens: 1200,
      }),
      0,
    );
  });

  test('a prompt trimmed right up to the ceiling still asks for a real reply', () => {
    // The trim ceiling and the leftover both took SAFETY_MARGIN, so a prompt
    // trimmed to fit left 0 and max_tokens clamped to 1 — every reply was "the".
    const modelLimit = 64512;
    const toolsReserveTokens = 2000;
    const ceiling = resolveContextBudget({
      agentConfig: { enforcementPolicy: 'dropMiddle' },
      modelLimit,
      reservedTokens: toolsReserveTokens,
    }).effectiveLimit!;
    const messages = [user('p'.repeat(Math.floor(ceiling * 3.6)))];
    assert.ok(estimateApiMessagesTokens(messages) <= ceiling);
    const window = resolveLocalWindowReserves({
      providerId: 'llama-cpp-local',
      maxTokens: 65000,
      modelLimit,
      toolsReserveTokens,
      messages,
    });
    assert.ok(window.requestMaxTokens >= LOCAL_MIN_GENERATION_TOKENS, `got ${window.requestMaxTokens}`);
  });

  test('an over-window prompt still gets the generation floor, capped by Settings max', () => {
    const messages = [user('p'.repeat(400_000))];
    for (const [maxTokens, expected] of [[65000, LOCAL_MIN_GENERATION_TOKENS], [512, 512]] as const) {
      const window = resolveLocalWindowReserves({
        providerId: 'llama-cpp-local',
        maxTokens,
        modelLimit: 64512,
        toolsReserveTokens: 0,
        messages,
      });
      assert.equal(window.requestMaxTokens, expected);
    }
  });

  test('an explicit override replaces both margin and reserve', () => {
    const resolved = resolveContextBudget({
      agentConfig: { enforcementPolicy: 'slide' },
      modelLimit: 32000,
      reservedTokens: 4000,
      effectiveLimitOverride: 9000,
    });
    assert.equal(resolved.effectiveLimit, 9000);
    assert.equal(resolved.modelLimit, 32000);
  });
});

// ── estimateApiMessageTokens ─────────────────────────────────────────────────

describe('estimateApiMessageTokens', () => {
  test('reasoning before the last user message is not priced — templates drop it', () => {
    const reasoning = 'r'.repeat(36_000);
    const thought = { role: 'assistant', content: 'ok', reasoning } as ApiMessage;
    const earlier = estimateApiMessagesTokens([user('go'), thought, user('continue')]);
    const live = estimateApiMessagesTokens([user('go'), thought]);
    assert.ok(live - earlier >= 9000, `live tool-loop reasoning still counts (${live} vs ${earlier})`);
    assert.ok(earlier < 100, `dropped reasoning must not be priced, got ${earlier}`);
  });

  test('tool output is priced above prose of the same length', () => {
    const text = 'x'.repeat(3600);
    const asTool = estimateApiMessageTokens(toolResult('t1', text));
    const asProse = estimateApiMessageTokens(user(text));
    assert.ok(asTool > asProse);
  });

  test('assistant tool_calls JSON is counted, not dropped', () => {
    const call: ToolCall = {
      id: 't1',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"src/app.ts"}' },
    };
    const withCall = estimateApiMessageTokens(assistantWithTools(null, [call]));
    assert.ok(withCall > 0);
    assert.ok(withCall > estimateApiMessageTokens(assistant('')));
  });

  test('replayed reasoning on an assistant row is counted', () => {
    // buildApiMessages can attach `reasoning` / `reasoning_content` outbound.
    // It is real payload in the request, so the budget has to see it.
    const plain = assistant('done');
    const withReasoning: ApiMessage = {
      ...(plain as object),
      role: 'assistant',
      reasoning: 'x'.repeat(3600),
    } as ApiMessage;
    assert.ok(
      estimateApiMessageTokens(withReasoning) > estimateApiMessageTokens(plain) + 900,
    );
  });

  test('an unreadable image part still costs the fallback budget', () => {
    // Truncated payload: no header to measure, so the flat fallback applies.
    const withImage: ApiMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA', detail: 'auto' } },
      ],
    };
    assert.ok(estimateApiMessageTokens(withImage) >= ESTIMATE_IMAGE_URL_TOKENS);
  });

  test('a tool-heavy transcript sums above a chars-over-four reading of it', () => {
    // The undercount that made enforcement unreachable: an agent transcript is
    // mostly tool payload, and chars÷4 read it 20–30% light.
    const messages: ApiMessage[] = [];
    for (let i = 0; i < 20; i += 1) {
      messages.push(toolResult(`t${i}`, 'src/components/panel.tsx:42:7'.repeat(20)));
    }
    const chars = messages.reduce((n, m) => n + (m as { content: string }).content.length, 0);
    assert.ok(estimateApiMessagesTokens(messages) > chars / 4);
  });
});

// ── applyContextBudget truncate ──────────────────────────────────────────────

describe('applyContextBudget truncate', () => {
  test('drops oldest history after system block', () => {
    const messages: ApiMessage[] = [
      system('sys'),
      user('a'.repeat(400)),
      assistant('b'.repeat(400)),
      user('c'.repeat(400)),
      assistant('d'.repeat(400)),
    ];
    const resolved = resolveContextBudget({
      agentConfig: { enforcementPolicy: 'truncate' },
      modelLimit: 400,
    });
    const out = applyContextBudget(messages, resolved, {
      enforcementPolicy: 'truncate',
    });
    assert.equal(out.applied, true);
    assert.ok(out.messages[0].role === 'system');
    assert.ok(estimateApiMessagesTokens(out.messages) <= (resolved.effectiveLimit ?? 0));
    assert.ok(out.droppedMessageCount >= 1);
  });

  test('does not remove leading system messages', () => {
    const messages: ApiMessage[] = [
      system('one'),
      system('two'),
      user('x'.repeat(2000)),
    ];
    const resolved = resolveContextBudget({
      agentConfig: { enforcementPolicy: 'truncate' },
      modelLimit: 120,
    });
    const out = applyContextBudget(messages, resolved, {
      enforcementPolicy: 'truncate',
    });
    assert.equal(out.messages[0].role, 'system');
    assert.equal((out.messages[0] as { content: string }).content, 'one');
    assert.equal((out.messages[1] as { content: string }).content, 'two');
  });
});

// ── applyContextBudget slide ─────────────────────────────────────────────────

describe('applyContextBudget slide', () => {
  test('removes oldest turns and keeps minRecentTurns', () => {
    const messages: ApiMessage[] = [
      system('sys'),
      user('turn1'),
      assistant('reply1'),
      user('turn2'),
      assistant('reply2'),
      user('turn3'),
      assistant('reply3'),
    ];
    const resolved = resolveContextBudget({
      agentConfig: {
        enforcementPolicy: 'slide',
        minRecentTurns: 1,
      },
      modelLimit: 8,
    });
    const out = applyContextBudget(messages, resolved, {
      enforcementPolicy: 'slide',
      minRecentTurns: 1,
    });
    assert.equal(out.applied, true);
    const text = out.messages.map((m) => serializeRoleContent(m)).join('|');
    assert.ok(!text.includes('turn1'));
    assert.ok(text.includes('turn3'));
  });

  test('drops assistant and tool messages as one turn', () => {
    const messages: ApiMessage[] = [
      system('sys'),
      user('old task'),
      assistantWithTools(null, [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'read_file', arguments: '{}' },
        },
      ]),
      toolResult('tc1', 'file body'),
      user('new task'),
      assistant('done'),
    ];
    const resolved = resolveContextBudget({
      agentConfig: { enforcementPolicy: 'slide' },
      modelLimit: 16,
    });
    const out = applyContextBudget(messages, resolved, {
      enforcementPolicy: 'slide',
      minRecentTurns: 1,
    });
    const serialized = out.messages.map((m) => serializeRoleContent(m)).join('\n');
    assert.ok(!serialized.includes('old task'));
    assert.ok(serialized.includes('new task'));
  });
});

// ── applyContextBudget dropMiddle ────────────────────────────────────────────

describe('applyContextBudget dropMiddle', () => {
  test('compresses board-task tool loops after a single user seed', () => {
    const messages: ApiMessage[] = [system('sys')];
    messages.push(user('Execute orchestrate task W1-A'));
    for (let round = 0; round < 8; round += 1) {
      messages.push(
        assistantWithTools(null, [
          {
            id: `call_${round}`,
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          },
        ]),
      );
      messages.push(toolResult(`call_${round}`, (`body ${round} `).repeat(20)));
    }
    const resolved = resolveContextBudget({
      agentConfig: {
        enforcementPolicy: 'dropMiddle',
        minRecentTurns: 2,
        summaryReserveTokens: 32,
      },
      modelLimit: 240,
    });
    const out = applyContextBudget(messages, resolved, {
      enforcementPolicy: 'dropMiddle',
      minRecentTurns: 2,
      summaryReserveTokens: 32,
    });
    assert.equal(out.applied, true);
    assert.equal(out.summaryInjected, true);
    assert.ok(out.droppedTurns > 0);
    assert.ok(out.tokensAfter <= (resolved.effectiveLimit ?? 0));
    const hasSummary = out.messages.some(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        m.content.includes('Prior context (compressed)'),
    );
    assert.ok(hasSummary);
    assertValidToolSequence(out.messages);
  });

  test('injects summary and stays under limit', () => {
    const messages: ApiMessage[] = [
      system('sys'),
      user('alpha '.repeat(40)),
      assistant('beta '.repeat(40)),
      user('gamma '.repeat(40)),
      assistant('delta '.repeat(40)),
    ];
    const resolved = resolveContextBudget({
      agentConfig: {
        enforcementPolicy: 'dropMiddle',
        minRecentTurns: 1,
        summaryReserveTokens: 32,
      },
      modelLimit: 20,
    });
    const out = applyContextBudget(messages, resolved, {
      enforcementPolicy: 'dropMiddle',
      minRecentTurns: 1,
      summaryReserveTokens: 32,
    });
    assert.equal(out.applied, true);
    assert.equal(out.summaryInjected, true);
    const hasSummary = out.messages.some(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        m.content.includes('Prior context (compressed)'),
    );
    assert.ok(hasSummary);
    assert.ok(out.tokensAfter < out.tokensBefore);
  });

  test('summarize policy defers to async path (no sync trim)', () => {
    const messages: ApiMessage[] = [
      system('sys'),
      user('a'.repeat(400)),
      assistant('b'.repeat(400)),
    ];
    const resolved = resolveContextBudget({
      agentConfig: { enforcementPolicy: 'summarize' },
      modelLimit: 100,
    });
    const out = applyContextBudget(messages, resolved);
    assert.equal(out.applied, false);
    assert.equal(out.messages.length, messages.length);
  });
});

// ── hard truncate single message ─────────────────────────────────────────────

describe('hard truncate single message', () => {
  test('adds truncation marker on oversized user line', () => {
    const messages: ApiMessage[] = [system('s'), user('z'.repeat(8000))];
    const resolved = resolveContextBudget({
      agentConfig: { enforcementPolicy: 'truncate' },
      modelLimit: 20,
    });
    const out = applyContextBudget(messages, resolved, {
      enforcementPolicy: 'truncate',
    });
    const lastUser = out.messages.find((m) => m.role === 'user');
    assert.ok(lastUser);
    assert.ok(
      typeof lastUser.content === 'string' &&
        lastUser.content.includes('[… truncated for context budget]'),
    );
  });
});

/** Assert an OpenAI-valid tool-call/tool-result sequence (no orphans, all answered). */
function assertValidToolSequence(messages: ApiMessage[]): void {
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const answered = new Set<string>();
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        answered.add((messages[j] as { tool_call_id: string }).tool_call_id);
        j += 1;
      }
      for (const call of m.tool_calls) {
        assert.ok(answered.has(call.id), `assistant tool_call ${call.id} is unanswered`);
      }
    }
    if (m.role === 'tool') {
      const prev = messages[i - 1];
      const owner =
        (prev?.role === 'assistant' && prev.tool_calls) ||
        (prev?.role === 'tool' && messages.slice(0, i).reverse().find((p) => p.role === 'assistant'));
      assert.ok(prev, `tool message at ${i} has no predecessor`);
      assert.notEqual(prev.role, 'system', `tool message at ${i} orphaned directly after system`);
      assert.notEqual(prev.role, 'user', `tool message at ${i} orphaned directly after user`);
      assert.ok(owner, `tool message at ${i} has no owning assistant`);
    }
  }
}

// ── applyContextBudget preserves ─────────────────────────────────────────────

describe('applyContextBudget preserves tool-call pairing (sub-agent single turn)', () => {
  test('dropMiddle never orphans a tool result after system', () => {
    const messages: ApiMessage[] = [
      system('s'.repeat(400)),
      user('research task ' + 'q'.repeat(200)),
      assistantWithTools(null, [
        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ]),
      toolResult('call_1', 'first file '.repeat(200)),
      assistantWithTools(null, [
        { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ]),
      toolResult('call_2', 'export default { plugins: {} }'),
    ];
    const resolved = resolveContextBudget({
      agentConfig: { enforcementPolicy: 'dropMiddle' },
      modelLimit: 50,
    });
    const out = applyContextBudget(messages, resolved, {
      enforcementPolicy: 'dropMiddle',
      minRecentTurns: 1,
    });
    assert.equal(out.applied, true);
    assert.equal(out.messages[0].role, 'system');
    assertValidToolSequence(out.messages);
  });

  test('truncate policy keeps the most recent assistant/tool pair intact', () => {
    const messages: ApiMessage[] = [
      system('s'),
      user('task'),
      assistantWithTools(null, [
        { id: 'call_9', type: 'function', function: { name: 'grep', arguments: '{}' } },
      ]),
      toolResult('call_9', 'z'.repeat(4000)),
    ];
    const resolved = resolveContextBudget({
      agentConfig: { enforcementPolicy: 'truncate' },
      modelLimit: 24,
    });
    const out = applyContextBudget(messages, resolved, {
      enforcementPolicy: 'truncate',
    });
    assertValidToolSequence(out.messages);
    const hasAssistant = out.messages.some(
      (m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.id === 'call_9'),
    );
    const hasTool = out.messages.some(
      (m) => m.role === 'tool' && m.tool_call_id === 'call_9',
    );
    assert.equal(hasAssistant, hasTool);
  });
});

// ── partitionTurns tool ──────────────────────────────────────────────────────

describe('partitionTurns tool screenshot follow-ups', () => {
  test('binds an image follow-up to the assistant tool-call unit', () => {
    const messages: ApiMessage[] = [
      system('sys'),
      user('check ui'),
      assistantWithTools('', [
        { id: 'c1', type: 'function', function: { name: 'browser_screenshot', arguments: '{}' } },
      ]),
      toolResult('c1', 'saved'),
      {
        role: 'user',
        content: [
          { type: 'text', text: '[tool screenshot]' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aaa' } },
        ],
        toolImageFollowUp: true,
      },
      assistant('looks fine'),
    ];
    const turns = partitionTurns(messages, 1);
    assert.deepEqual(turns, [
      { start: 1, end: 2 },
      { start: 2, end: 5 },
      { start: 5, end: 6 },
    ]);
  });
});

// ── formatContextTrimStatus ──────────────────────────────────────────────────

describe('formatContextTrimStatus', () => {
  test('includes policy and drop count', () => {
    const line = formatContextTrimStatus('slide', 4, false);
    assert.match(line, /slide/);
    assert.match(line, /4 older turns/);
  });
});

// ── applyContextBudget archive ───────────────────────────────────────────────

describe('applyContextBudget archive', () => {
  test('archive policy uses slide behavior', () => {
    const messages: ApiMessage[] = [
      system('sys'),
      user('a'.repeat(400)),
      assistant('b'.repeat(400)),
      user('c'.repeat(400)),
      assistant('d'.repeat(400)),
    ];
    const resolved = resolveContextBudget({
      agentConfig: { enforcementPolicy: 'archive' },
      modelLimit: 400,
    });
    const out = applyContextBudget(messages, resolved, {
      enforcementPolicy: 'archive',
      minRecentTurns: 1,
    });
    assert.equal(out.applied, true);
    assert.equal(out.policy, 'archive');
    assert.ok(out.tokensAfter <= (resolved.effectiveLimit ?? 0));
  });
});

function serializeRoleContent(m: ApiMessage): string {
  if (m.role === 'user' || m.role === 'assistant' || m.role === 'system') {
    return typeof m.content === 'string' ? m.content : '';
  }
  if (m.role === 'tool') return m.content;
  return '';
}
