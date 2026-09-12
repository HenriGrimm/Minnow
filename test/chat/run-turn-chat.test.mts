/**
 * P6-D: every product send goes through `runTurn()`. No dual-path flag.
 */

import '../tools/install-dom-before-imports.mts';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, test } from 'node:test';
import type { Chat, Message } from '../../src/types.ts';
import {
  createEmptyChatObject,
  flushScheduledSessionSaveForTests,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { findRunById } from '../../src/state/runs-store.ts';
import { CONTINUE_AFTER_TRUNCATION_INSTRUCTION, EMPTY_POST_TOOL_CONTINUE_INSTRUCTION } from '../../src/tools/turn-continuation.ts';
import { endChatTurnSetup } from '../../src/chat/chat-turn-guard.ts';
import { getMainTurnActivity } from '../../src/chat/main-turn-activity.ts';
import { getChatAbort, setChatAbort, setStreaming } from '../../src/app-state.ts';
import { DEFAULT_TITLES_CONFIG, setTitlesConfigForTests } from '../../src/config/titles-meta.ts';
import {
  resetSamplerMetaCache,
  setSamplerMetaForTests,
} from '../../src/config/sampler-meta.ts';
import {
  appendIsolatedProductRows,
  maybeRunChatTurnViaRunner,
  resetRunTurnForTests,
  setChatLibraryAndServesForTests,
  setChatModelLoadForTests,
  setRunTurnForTests,
} from '../../src/chat/run-turn-chat.ts';
import { modelCache } from '../../src/app-state.ts';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';
import { LIBRARY_MODEL_PROVIDER_ID } from '../../src/models/model-select-library.ts';
import type { LibraryModel } from '../../src/models/library.ts';
import type { ServeRecord } from '../../src/models/api-client.ts';
import type { LmModelRecord } from '../../src/types.ts';
import { STREAM_LABEL_LOADING_MODEL } from '../../src/ui/stream-status.ts';
import type { RunTurnOptions, TurnResult } from '../../server/runner/run-turn';
import { getSubAgentExecutorContext } from '../../src/tools/sub-agent-executor.ts';
import type { SubAgentExecutorContext } from '../../src/agents/types.ts';
import { parallelToolsActivityLabel } from '../../src/tools/parallel-tool-policy.ts';

const CHAT_ID = '11111111-1111-1111-1111-111111111111';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function installChatDom(): void {
  document.body.replaceChildren();
  const chatArea = document.createElement('div');
  chatArea.id = 'chatArea';
  document.body.appendChild(chatArea);

  const sDot = document.createElement('span');
  sDot.id = 'sDot';
  document.body.appendChild(sDot);
  const sText = document.createElement('span');
  sText.id = 'sText';
  document.body.appendChild(sText);

  const msgInput = document.createElement('textarea');
  msgInput.id = 'msgInput';
  document.body.appendChild(msgInput);
}

function makeChat(): Chat {
  const chat = createEmptyChatObject('m1');
  chat.id = CHAT_ID;
  chat.providerId = 'vite-fallback';
  chat.modelId = 'm1';
  return chat;
}

const SIMPLE_TURN = {
  pushUser: true as const,
  rawText: 'What time is it?',
  userText: 'What time is it?',
  skillId: null,
  displayText: 'What time is it?',
  historyContent: 'What time is it?',
  validAttachments: [] as [],
  ownsGlobalStreaming: true,
};

describe('P6-D runTurn chat adapter (MIN-726)', () => {
  afterEach(() => {
    resetRunTurnForTests();
    getChatAbort(CHAT_ID)?.abort();
    setChatAbort(CHAT_ID, null);
    setStreaming(false, CHAT_ID);
    endChatTurnSetup(CHAT_ID);
    flushScheduledSessionSaveForTests();
    setSessionStateForTests(null);
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    resetSamplerMetaCache();
  });

  test('simple turn always invokes runTurn (no dual-path flag)', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    const calls: RunTurnOptions[] = [];
    setRunTurnForTests(async (options) => {
      calls.push(options);
      options.onEvent?.({ type: 'thinking', text: 'checking the clock' });
      options.onEvent?.({ type: 'delta', text: 'It is noon.' });
      options.onEvent?.({
        type: 'tool_call',
        name: 'get_datetime',
        id: 'call_dt',
        arguments: '{}',
      });
      options.onEvent?.({
        type: 'tool_result',
        name: 'get_datetime',
        id: 'call_dt',
        content: '2026-08-31T12:00:00.000Z',
      });
      return { outcome: 'no_report' } satisfies TurnResult;
    });

    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({
      chat,
      ...SIMPLE_TURN,
    });

    assert.equal(calls.length, 1, 'runTurn must be invoked, not merely imported');
    assert.equal(calls[0]?.chatId, CHAT_ID);
    assert.equal(calls[0]?.seed, 'What time is it?');
    assert.equal(calls[0]?.seedKind, 'continue');
    assert.equal(calls[0]?.injectReportTool, false);
    assert.equal(calls[0]?.nudgeToolUse, false);
    assert.equal(calls[0]?.finalizeStructuredOutcome, false);
    assert.ok(typeof calls[0]?.systemPrompt === 'string' && calls[0].systemPrompt.length > 0);
    const toolNames = (calls[0]?.tools ?? []).map((t) => t.function.name);
    assert.equal(toolNames.includes('report_outcome'), false, 'chat must not inject report_outcome');
    assert.ok(toolNames.length > 0, 'mode catalog (or spike floor) must be passed');
    assert.equal(typeof calls[0]?.onEvent, 'function');
    assert.equal(typeof calls[0]?.ask?.ask, 'function', 'P6-B: adapter must inject AskCapability');
    assert.equal(
      typeof calls[0]?.onRoundBoundary,
      'function',
      'P10-I: adapter must inject onRoundBoundary',
    );
    assert.ok(typeof calls[0]?.askTimeoutMs === 'number' && calls[0].askTimeoutMs > 0);
    assert.ok(calls[0]?.limits, 'product chat must pass context policy + model window');
    assert.ok('modelContextLimit' in (calls[0]?.limits ?? {}));
    assert.ok('contextBudget' in (calls[0]?.limits ?? {}));
    assert.ok(chat.history.some((m) => m.role === 'user'));
    const area = document.getElementById('chatArea');
    assert.ok(area?.querySelector('.msg-bubble'), 'delta must paint the assistant bubble');
    assert.ok(area?.querySelector('.tool-call-msg'), 'tool_call must paint a tool row');
  });

  test('My Models chat budgets against the running serve window, not the cache row', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    const LIB_ID = 'gguf:unsloth/qwen:Qwen3.8-27B-UD-IQ4_XS.gguf';
    const ALIAS = 'Qwen3.8-27B-UD-IQ4_XS';
    const library = [
      {
        id: LIB_ID,
        name: ALIAS,
        repoId: 'unsloth/qwen',
        format: 'GGUF',
        path: '/models/Qwen3.8-27B-UD-IQ4_XS.gguf',
        fileName: 'Qwen3.8-27B-UD-IQ4_XS.gguf',
      },
    ] as unknown as LibraryModel[];
    const serves = [
      {
        id: 'serve-qwen',
        runtime: 'llama-cpp',
        modelPath: '/models/Qwen3.8-27B-UD-IQ4_XS.gguf',
        modelLabel: ALIAS,
        providerId: 'llama-cpp-local',
        status: 'running',
        llamaSettings: { ctx: 64_512, parallel: 1 },
      },
    ] as unknown as ServeRecord[];
    setChatLibraryAndServesForTests(async () => ({ library, serves }));
    // A stale row claiming n_ctx_train must not beat the live `-c`.
    const staleRow = { id: ALIAS, state: 'loaded', max_context_length: 262_144 } as LmModelRecord;
    modelCache.set(ALIAS, staleRow);
    modelCache.set(encodeModelSelectKey('llama-cpp-local', ALIAS), staleRow);

    const calls: RunTurnOptions[] = [];
    setRunTurnForTests(async (options) => {
      calls.push(options);
      return { outcome: 'no_report' } satisfies TurnResult;
    });
    const chat = makeChat();
    chat.providerId = LIBRARY_MODEL_PROVIDER_ID;
    chat.modelId = LIB_ID;
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    try {
      const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
      await runChatTurn({ chat, ...SIMPLE_TURN });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.model.id, ALIAS);
      assert.equal(calls[0]?.limits?.modelContextLimit, 64_512);
      assert.equal(chat.modelInfo?.context_length, 64_512, 'ring reads the served window too');
    } finally {
      modelCache.delete(ALIAS);
      modelCache.delete(encodeModelSelectKey('llama-cpp-local', ALIAS));
    }
  });

  test('main chat passes Settings sampler max tokens into runTurn (not the 2048 sub-agent fallback)', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    // Distinctive ceiling so a missing model.sampler (2048) or the shipped
    // Settings default (32768) cannot pass this assertion by accident.
    setSamplerMetaForTests({ temperature: 1, maxTokens: 131072 });
    const calls: RunTurnOptions[] = [];
    setRunTurnForTests(async (options) => {
      calls.push(options);
      options.onEvent?.({ type: 'delta', text: 'ok' });
      return { outcome: 'no_report' } satisfies TurnResult;
    });

    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({
      chat,
      ...SIMPLE_TURN,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.model.sampler?.maxTokens, 131072);
    assert.ok(calls[0]?.model.sampler?.preset);
  });

  test('leftover exclusive shapes still invoke runTurn (attachments, Super Plan, resume, skill)', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    const seeds: Array<{ seed: string; inject: boolean | undefined }> = [];
    setRunTurnForTests(async (options) => {
      seeds.push({ seed: options.seed, inject: options.injectReportTool });
      return { outcome: 'no_report' };
    });
    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({
      chat,
      pushUser: true,
      rawText: 'see this',
      userText: 'see this',
      skillId: 'impeccable',
      historyContent: 'see this\n\n[image: shot.png]',
      validAttachments: [
        {
          id: 'att-1',
          name: 'shot.png',
          kind: 'image',
          mimeType: 'image/png',
          size: 8,
          dataUrl: 'data:image/png;base64,c2hvdA==',
        },
      ],
      suppressUserEcho: true,
    });
    await runChatTurn({
      chat,
      pushUser: false,
      rawText: '',
      userText: '',
      skillId: null,
      historyContent: '',
      validAttachments: [],
      resumeGenerationId: 'gen-resume-1',
      ownsGlobalStreaming: false,
    });

    assert.ok(seeds.length >= 2, 'attachments/skill and resume must both call runTurn');
    assert.ok(seeds.every((s) => s.inject === false));
  });

  test('adapter imports isomorphic runner index, not node.js or tool-dispatch', () => {
    const src = fs.readFileSync(
      path.join(PROJECT_ROOT, 'src', 'chat', 'run-turn-chat.ts'),
      'utf8',
    );
    const importLines = src.split('\n').filter((line) => /^\s*import\b/.test(line));
    assert.ok(
      importLines.some((line) => /server\/runner\/index\.js/.test(line)),
      'must import runTurn from the isomorphic barrel',
    );
    assert.equal(
      importLines.some((line) => /server\/runner\/node/.test(line)),
      false,
    );
    assert.equal(
      importLines.some((line) => /tool-dispatch/.test(line)),
      false,
    );
  });

  test('maybeRunChatTurnViaRunner always routes (flag deleted)', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    let called = 0;
    setRunTurnForTests(async () => {
      called += 1;
      return { outcome: 'no_report' };
    });
    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const routed = await maybeRunChatTurnViaRunner({
      chat,
      ...SIMPLE_TURN,
    });
    assert.equal(routed, true);
    assert.equal(called, 1);
  });

  test('appendIsolatedProductRows copies assistant/tool and skips system/user nudges', () => {
    const chat = makeChat();
    appendIsolatedProductRows(chat, [
      { role: 'system', content: 'When you have a result, call the report tool.' },
      { role: 'user', content: 'What time is it?' },
      { role: 'assistant', content: 'Let me check.' },
      { role: 'tool', content: 'noon' },
      { role: 'user', content: 'Please call a tool.' },
      { role: 'assistant', content: 'It is noon.' },
    ]);
    assert.deepEqual(
      chat.history.map((m) => m.role),
      ['assistant', 'tool', 'assistant'],
    );
  });

  test('src has no tools/loop imports after P6-D', () => {
    const srcDir = path.join(PROJECT_ROOT, 'src');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|js|mjs|mts)$/.test(ent.name)) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (text.includes('tools/loop')) hits.push(path.relative(PROJECT_ROOT, full));
      }
    };
    walk(srcDir);
    assert.deepEqual(hits, [], 'rg tools/loop src must be empty');
  });

  test('skill-tagged send passes seed: historyContent and keeps one user row', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    const calls: RunTurnOptions[] = [];
    setRunTurnForTests(async (options) => {
      calls.push(options);
      return { outcome: 'no_report' };
    });
    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const historyContent = 'polish the login\n\n[skill: impeccable]';
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({
      chat,
      pushUser: true,
      rawText: 'polish the login',
      userText: 'polish the login',
      skillId: 'impeccable',
      historyContent,
      validAttachments: [],
      ownsGlobalStreaming: true,
    });

    assert.equal(calls[0]?.seed, historyContent);
    assert.equal(chat.history.filter((m) => m.role === 'user').length, 1);
    assert.equal(chat.history[0]?.content, historyContent);
  });

  test('ephemeralContinueInstruction still wins over historyContent', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    const calls: RunTurnOptions[] = [];
    setRunTurnForTests(async (options) => {
      calls.push(options);
      return { outcome: 'no_report' };
    });
    const chat = makeChat();
    chat.history = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'partial', truncated: true },
    ];
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({
      chat,
      pushUser: false,
      rawText: '',
      userText: '',
      skillId: null,
      historyContent: 'hello',
      validAttachments: [],
      ephemeralContinueInstruction: CONTINUE_AFTER_TRUNCATION_INSTRUCTION,
      ownsGlobalStreaming: true,
    });

    assert.equal(calls[0]?.seed, CONTINUE_AFTER_TRUNCATION_INSTRUCTION);
  });

  test('P10-D tool turn persist: thoughts, stats, attachments, no nudge, run range', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    setRunTurnForTests(async (options) => {
      const transcript = options.transcript;
      assert.ok(transcript, 'chat adapter must pass the decorating store');
      options.onEvent?.({ type: 'round_start', index: 0 });
      options.onEvent?.({ type: 'thinking', text: 'I should call get_datetime' });
      options.onEvent?.({ type: 'reasoning_end' });
      options.onEvent?.({
        type: 'stream_meta',
        usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
        stats: { tokens_per_second: 12.5 },
        finishReason: 'tool_calls',
      });
      transcript.append(options.chatId, {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_dt',
            type: 'function',
            function: { name: 'get_datetime', arguments: '{}' },
          },
        ],
        reasoning: 'I should call get_datetime',
        reasoning_content: 'I should call get_datetime',
      });
      options.onEvent?.({
        type: 'tool_result',
        name: 'get_datetime',
        id: 'call_dt',
        content: '2026-08-31T12:00:00.000Z',
        attachments: [{ type: 'image', url: '/tmp/shot.png', mime: 'image/png' }],
        codeChange: { additions: 3, deletions: 1, path: 'src/a.ts', source: 'file-tool' },
      });
      transcript.append(options.chatId, {
        role: 'tool',
        tool_call_id: 'call_dt',
        content: '2026-08-31T12:00:00.000Z',
      });
      transcript.append(options.chatId, {
        role: 'user',
        content: EMPTY_POST_TOOL_CONTINUE_INSTRUCTION,
      });
      options.onEvent?.({
        type: 'round_end',
        index: 0,
        text: '',
        reasoning: 'I should call get_datetime',
        toolCallCount: 1,
        usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
        stats: { tokens_per_second: 12.5 },
        finishReason: 'tool_calls',
        t0: 0,
        tFirst: 1,
        tEnd: 2,
      });
      return { outcome: 'no_report' };
    });

    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({
      chat,
      ...SIMPLE_TURN,
    });

    const userRows = chat.history.filter((m) => m.role === 'user');
    assert.equal(userRows.length, 1, 'inner-loop nudge must not appear in chat.history');
    const assistant = chat.history.find((m) => m.role === 'assistant') as Extract<
      Message,
      { role: 'assistant' }
    >;
    const tool = chat.history.find((m) => m.role === 'tool') as Extract<Message, { role: 'tool' }>;
    assert.ok(assistant);
    assert.deepEqual(assistant.thinking, ['I should call get_datetime']);
    assert.equal(assistant.usage?.prompt_tokens, 40);
    assert.equal(assistant.stats?.tokens_per_second, 12.5);
    assert.equal('reasoning' in assistant, false);
    assert.equal('reasoning_content' in assistant, false);
    assert.ok(tool);
    assert.equal(tool.attachments?.[0]?.url, '/tmp/shot.png');
    assert.equal(tool.codeChange?.additions, 3);

    const run = chat.runs?.find((r) => r.status === 'completed' || r.status === 'running' || r.status === 'failed');
    const recorded = run ? findRunById(chat, run.runId) : undefined;
    assert.ok(recorded?.outputHistoryStart !== undefined);
    assert.ok(recorded?.outputHistoryEnd !== undefined);
    assert.ok((recorded?.outputHistoryEnd ?? 0) >= (recorded?.outputHistoryStart ?? 0));
  });

  test('P10-F two-round tool turn: live DOM is assistant, tool, assistant matching history', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    setRunTurnForTests(async (options) => {
      const transcript = options.transcript;
      assert.ok(transcript);
      options.onEvent?.({ type: 'round_start', index: 0 });
      options.onEvent?.({ type: 'thinking', text: 'need the clock' });
      options.onEvent?.({ type: 'reasoning_end' });
      options.onEvent?.({ type: 'delta', text: 'Let me check.' });
      options.onEvent?.({
        type: 'tool_call',
        name: 'get_datetime',
        id: 'call_dt',
        arguments: '{}',
      });
      transcript.append(options.chatId, {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [
          {
            id: 'call_dt',
            type: 'function',
            function: { name: 'get_datetime', arguments: '{}' },
          },
        ],
      });
      options.onEvent?.({
        type: 'tool_result',
        name: 'get_datetime',
        id: 'call_dt',
        content: '2026-08-31T12:00:00.000Z',
      });
      transcript.append(options.chatId, {
        role: 'tool',
        tool_call_id: 'call_dt',
        content: '2026-08-31T12:00:00.000Z',
      });
      options.onEvent?.({
        type: 'round_end',
        index: 0,
        text: 'Let me check.',
        reasoning: 'need the clock',
        toolCallCount: 1,
        t0: 0,
        tFirst: 1,
        tEnd: 2,
      });
      options.onEvent?.({ type: 'round_start', index: 1 });
      options.onEvent?.({ type: 'thinking', text: 'got it' });
      options.onEvent?.({ type: 'reasoning_end' });
      options.onEvent?.({ type: 'delta', text: 'It is noon.' });
      transcript.append(options.chatId, {
        role: 'assistant',
        content: 'It is noon.',
      });
      options.onEvent?.({
        type: 'round_end',
        index: 1,
        text: 'It is noon.',
        reasoning: 'got it',
        toolCallCount: 0,
        t0: 0,
        tFirst: 1,
        tEnd: 2,
      });
      return { outcome: 'no_report' };
    });

    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({
      chat,
      ...SIMPLE_TURN,
    });

    const roles = chat.history.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'tool', 'assistant']);

    const area = document.getElementById('chatArea');
    assert.ok(area);
    const live = [...area.children].map((el) => {
      if (el.classList.contains('tool-call-msg')) return 'tool';
      if (el.classList.contains('msg') && el.classList.contains('assistant')) return 'assistant';
      if (el.classList.contains('msg') && el.classList.contains('user')) return 'user';
      return el.className;
    });
    assert.deepEqual(
      live,
      ['user', 'assistant', 'tool', 'assistant'],
      'live row order must match history so stream-end rebuild is a visual no-op',
    );
    const assistantRows = area.querySelectorAll('.msg.assistant');
    assert.equal(assistantRows.length, 2);
    assert.equal(assistantRows[0]?.querySelectorAll('.thoughts-toggle').length, 1);
    assert.equal(assistantRows[1]?.querySelectorAll('.thoughts-toggle').length, 1);
    assert.ok(
      assistantRows[1]?.querySelector('.message-actions__trigger'),
      'message actions present on the live final row',
    );
    assert.equal(document.getElementById('sText')?.textContent, 'Ready');
  });

  test('P10-G three-round turn: live stats, lastStats, per-message footer, main ledger', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    setRunTurnForTests(async (options) => {
      const transcript = options.transcript;
      assert.ok(transcript);

      const emitRound = (index: number, opts: {
        text: string;
        reasoning: string;
        tool?: { id: string; name: string; result: string };
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        stats: { tokens_per_second: number; generation_time: number; time_to_first_token: number };
        t0: number;
        tFirst: number;
        tEnd: number;
      }) => {
        options.onEvent?.({ type: 'round_start', index });
        options.onEvent?.({
          type: 'stream_meta',
          usage: opts.usage,
          stats: opts.stats,
          model: 'fake-local',
        });
        options.onEvent?.({ type: 'thinking', text: opts.reasoning });
        options.onEvent?.({ type: 'reasoning_end' });
        options.onEvent?.({ type: 'delta', text: opts.text });
        if (opts.tool) {
          options.onEvent?.({
            type: 'tool_call',
            name: opts.tool.name,
            id: opts.tool.id,
            arguments: '{}',
          });
          transcript.append(options.chatId, {
            role: 'assistant',
            content: opts.text,
            tool_calls: [
              {
                id: opts.tool.id,
                type: 'function',
                function: { name: opts.tool.name, arguments: '{}' },
              },
            ],
          });
          options.onEvent?.({
            type: 'tool_result',
            name: opts.tool.name,
            id: opts.tool.id,
            content: opts.tool.result,
          });
          transcript.append(options.chatId, {
            role: 'tool',
            tool_call_id: opts.tool.id,
            content: opts.tool.result,
          });
        } else {
          transcript.append(options.chatId, { role: 'assistant', content: opts.text });
        }
        options.onEvent?.({
          type: 'round_end',
          index,
          text: opts.text,
          reasoning: opts.reasoning,
          toolCallCount: opts.tool ? 1 : 0,
          usage: opts.usage,
          stats: opts.stats,
          t0: opts.t0,
          tFirst: opts.tFirst,
          tEnd: opts.tEnd,
        });
      };

      emitRound(0, {
        text: 'Let me check.',
        reasoning: 'need the clock',
        tool: { id: 'call_dt', name: 'get_datetime', result: 'noon' },
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
        stats: { tokens_per_second: 10, generation_time: 10, time_to_first_token: 0.1 },
        t0: 0,
        tFirst: 100,
        tEnd: 10_100,
      });
      emitRound(1, {
        text: 'Need the weather too.',
        reasoning: 'weather',
        tool: { id: 'call_wx', name: 'get_datetime', result: 'sunny' },
        usage: { prompt_tokens: 2000, completion_tokens: 200, total_tokens: 2200 },
        stats: { tokens_per_second: 20, generation_time: 10, time_to_first_token: 0.1 },
        t0: 20_000,
        tFirst: 20_100,
        tEnd: 30_100,
      });
      emitRound(2, {
        text: 'It is noon and sunny.',
        reasoning: 'done',
        usage: { prompt_tokens: 3000, completion_tokens: 50, total_tokens: 3050 },
        stats: { tokens_per_second: 50, generation_time: 1, time_to_first_token: 0.1 },
        t0: 40_000,
        tFirst: 40_100,
        tEnd: 41_100,
      });
      return { outcome: 'no_report' };
    });

    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({
      chat,
      ...SIMPLE_TURN,
    });

    // Token counts are context occupancy — the final round's prompt + reply.
    // Summing completions (100 + 200 + 50) double-counts: rounds 0 and 1 are
    // already inside round 2's 3000-token prompt, and that rollup is what used
    // to make the strip disagree with the ring and the last assistant chip.
    assert.equal(chat.lastStats?.prompt_tokens, 3000, 'strip keeps latest prompt, not a sum');
    assert.equal(chat.lastStats?.completion_tokens, 50, 'final round only, not the turn rollup');
    assert.equal(chat.lastStats?.total_tokens, 3050);
    // Rates still average across every round of the turn.
    assert.ok(chat.lastStats?.tokens_per_second != null);
    assert.ok(
      Math.abs((chat.lastStats?.tokens_per_second ?? 0) - 21.428571) < 0.05,
      `weighted tok/s, got ${chat.lastStats?.tokens_per_second}`,
    );
    assert.ok(chat.modelInfo && typeof chat.modelInfo === 'object');

    const area = document.getElementById('chatArea');
    const assistantRows = area?.querySelectorAll('.msg.assistant') ?? [];
    assert.equal(assistantRows.length, 3);
    for (const row of assistantRows) {
      assert.ok(row.querySelector('.msg-stats'), 'per-message stats footer on each live row');
    }

    const entries = chat.tokenLedger?.entries ?? [];
    assert.equal(entries.length, 3, 'one ledger row per model round');
    assert.ok(
      entries.every((e) => e.source.kind === 'main'),
      'main-chat turns must not land on the sub-agent helper',
    );
    assert.equal(entries[0]?.usage.prompt_tokens, 1000);
    assert.equal(entries[2]?.usage.prompt_tokens, 3000);
  });

  test('six parallel read tool_calls show the aggregate activity label', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    setRunTurnForTests(async (options) => {
      for (let i = 0; i < 6; i += 1) {
        options.onEvent?.({
          type: 'tool_call',
          name: 'get_datetime',
          id: `call_par_${i}`,
          arguments: '{}',
        });
      }
      assert.equal(
        getMainTurnActivity(CHAT_ID)?.currentTool,
        parallelToolsActivityLabel(6),
      );
      return { outcome: 'no_report' } satisfies TurnResult;
    });

    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({
      chat,
      ...SIMPLE_TURN,
    });
  });

  test('execute sets sub-agent parent context and finally clears it', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    let seenDuringExecute: SubAgentExecutorContext | null = null;
    setRunTurnForTests(async (options) => {
      await options.execute?.('get_datetime', {}, {
        toolCallId: 'call_ctx',
        chatId: CHAT_ID,
      });
      seenDuringExecute = getSubAgentExecutorContext();
      return { outcome: 'no_report' } satisfies TurnResult;
    });

    const chat = makeChat();
    chat.modeId = 'debug';
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({
      chat,
      ...SIMPLE_TURN,
    });
    assert.ok(seenDuringExecute);
    // spawn_sub_agent reads this same latch (P10-K / MIN-776).
    assert.equal(seenDuringExecute.parentToolCallId, 'call_ctx');
    assert.equal(seenDuringExecute.parentChatId, CHAT_ID);
    assert.equal(seenDuringExecute.modeId, 'debug');
    assert.ok(seenDuringExecute.parentTurnId);
    const turn = chat.runs?.find((r) => r.runId === seenDuringExecute?.parentTurnId);
    assert.ok(turn, 'parentTurnId must match the turn run cancelAllForParentTurn indexes');
    assert.equal(getSubAgentExecutorContext(), null);
  });

  test('execute clears sub-agent parent context after a returned Stop', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    let seenDuringExecute: SubAgentExecutorContext | null = null;
    setRunTurnForTests(async (options) => {
      await options.execute?.('get_datetime', {}, {
        toolCallId: 'call_stop',
        chatId: CHAT_ID,
      });
      seenDuringExecute = getSubAgentExecutorContext();
      return { outcome: 'crashed', error: 'aborted' } satisfies TurnResult;
    });

    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({
      chat,
      ...SIMPLE_TURN,
    });
    assert.ok(seenDuringExecute?.parentToolCallId);
    assert.ok(seenDuringExecute?.parentTurnId);
    assert.ok(seenDuringExecute?.modeId);
    assert.equal(getSubAgentExecutorContext(), null);
  });

  test('execute clears sub-agent parent context after a thrown error', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    let seenDuringExecute: SubAgentExecutorContext | null = null;
    setRunTurnForTests(async (options) => {
      await options.execute?.('get_datetime', {}, {
        toolCallId: 'call_err',
        chatId: CHAT_ID,
      });
      seenDuringExecute = getSubAgentExecutorContext();
      throw new Error('provider exploded');
    });

    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({
      chat,
      ...SIMPLE_TURN,
    });
    assert.ok(seenDuringExecute?.parentToolCallId);
    assert.ok(seenDuringExecute?.parentTurnId);
    assert.ok(seenDuringExecute?.modeId);
    assert.equal(getSubAgentExecutorContext(), null);
  });
});

describe('P10-I in-turn steer and context overlay (MIN-774)', () => {
  afterEach(() => {
    resetRunTurnForTests();
    getChatAbort(CHAT_ID)?.abort();
    setChatAbort(CHAT_ID, null);
    setStreaming(false, CHAT_ID);
    endChatTurnSetup(CHAT_ID);
    flushScheduledSessionSaveForTests();
    setSessionStateForTests(null);
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
  });

  test('runChatTurn source no longer aborts on steer', () => {
    const src = fs.readFileSync(
      path.join(PROJECT_ROOT, 'src', 'chat', 'run-turn-chat.ts'),
      'utf8',
    );
    assert.equal(src.includes('abortedForSteer'), false);
    assert.equal(src.includes('setSteerEnqueuedListener'), false);
    assert.ok(src.includes('onRoundBoundary'));
    assert.ok(src.includes('createChatRoundBoundary'));
  });

  test('steer at the round boundary continues the same turn and is not failed', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    const STEER = 'Use pnpm not npm';
    setRunTurnForTests(async (options) => {
      options.onEvent?.({ type: 'delta', text: 'Listing files…' });
      options.onEvent?.({
        type: 'tool_call',
        name: 'list_dir',
        id: 'call_ls',
        arguments: '{}',
      });
      options.onEvent?.({
        type: 'tool_result',
        name: 'list_dir',
        id: 'call_ls',
        content: '[]',
      });
      // Simulate enqueue mid-turn, then the runner consulting the hook.
      const chat = (await import('../../src/state/sessions.ts')).findChatById(CHAT_ID);
      assert.ok(chat);
      chat.pendingSteerMessage = STEER;
      const rows = options.onRoundBoundary?.() ?? null;
      assert.ok(rows);
      assert.equal(rows[0]?.role, 'user');
      assert.equal(rows[0]?.content, STEER);
      options.onEvent?.({ type: 'delta', text: 'Switched to pnpm.' });
      return { outcome: 'no_report' } satisfies TurnResult;
    });

    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({
      chat,
      ...SIMPLE_TURN,
    });

    const steered = chat.history.filter((m) => m.role === 'user' && (m as { steer?: boolean }).steer);
    assert.equal(steered.length, 1);
    assert.equal(steered[0]?.content, STEER);
    const failed = chat.runs?.some((r) => r.status === 'failed');
    assert.equal(failed, false);
    assert.ok(chat.runs?.some((r) => r.status === 'completed'));
  });

  test('context overlay writes at most once per paint tick, not per token', async () => {
    const {
      resetContextOverlayWriteCountForTests,
      getContextOverlayWriteCountForTests,
      getContextInFlightOverlay,
    } = await import('../../src/chat/context-in-flight.ts');
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();
    resetContextOverlayWriteCountForTests();

    setRunTurnForTests(async (options) => {
      for (let i = 1; i <= 20; i += 1) {
        options.onEvent?.({ type: 'delta', text: 'x'.repeat(i) });
      }
      await new Promise<void>((resolve) => {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => resolve());
        } else {
          setTimeout(resolve, 20);
        }
      });
      const afterBurst = getContextOverlayWriteCountForTests();
      assert.equal(afterBurst, 1, `expected 1 overlay write after 20 deltas, got ${afterBurst}`);
      options.onEvent?.({
        type: 'tool_call',
        name: 'get_datetime',
        id: 'call_dt',
        arguments: '{}',
      });
      assert.ok(
        getContextOverlayWriteCountForTests() > afterBurst,
        'tool_call must write the overlay with serialized calls',
      );
      const overlay = getContextInFlightOverlay(CHAT_ID);
      assert.ok(overlay?.pendingToolCallsJson?.includes('get_datetime'));
      return { outcome: 'no_report' } satisfies TurnResult;
    });

    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    await runChatTurn({
      chat,
      ...SIMPLE_TURN,
    });
    // finally clears the overlay so the ring can settle post-turn.
    assert.equal(getContextInFlightOverlay(CHAT_ID), undefined);
  });

  test('pending model load shows load percent beside Loading model…', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();

    const { getModelsState } = await import('../../src/ui/models/store.ts');
    getModelsState().loads = [
      {
        serveId: 'serve-load-chat',
        modelId: 'gguf:acme/model:weights/model-Q4_K_M.gguf',
        percent: 42,
        phase: 'Loading weights',
        phaseKey: 'weights',
        etaMs: null,
        bytesTotal: 4_000_000_000,
        startedAt: 1_700_000_000_000,
        error: null,
      },
    ];

    let releaseLoad!: () => void;
    let markLoadStarted!: () => void;
    const loadStarted = new Promise<void>((resolve) => {
      markLoadStarted = resolve;
    });
    const loadHeld = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });

    setChatModelLoadForTests({
      needsLoad: () => true,
      ensure: async () => {
        markLoadStarted();
        await loadHeld;
      },
    });
    setRunTurnForTests(async (options) => {
      options.onEvent?.({ type: 'delta', text: 'Ready.' });
      return { outcome: 'no_report' } satisfies TurnResult;
    });

    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    const turnPromise = runChatTurn({
      chat,
      ...SIMPLE_TURN,
    });

    await loadStarted;
    const detail = document.querySelector('.stream-status__detail');
    assert.equal(detail?.textContent?.trim(), '42%');
    assert.equal(detail?.hidden, false);

    releaseLoad();
    await turnPromise;
    getModelsState().loads.length = 0;
  });

  test('pending model load shows Loading model… in the transcript before completions', async () => {
    setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
    installChatDom();

    let releaseLoad!: () => void;
    let markLoadStarted!: () => void;
    const loadStarted = new Promise<void>((resolve) => {
      markLoadStarted = resolve;
    });
    const loadHeld = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let completionsStarted = false;

    setChatModelLoadForTests({
      needsLoad: () => true,
      ensure: async () => {
        markLoadStarted();
        await loadHeld;
      },
    });
    setRunTurnForTests(async (options) => {
      completionsStarted = true;
      options.onEvent?.({ type: 'delta', text: 'Ready.' });
      return { outcome: 'no_report' } satisfies TurnResult;
    });

    const chat = makeChat();
    setSessionStateForTests({
      version: 3,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
    const turnPromise = runChatTurn({
      chat,
      ...SIMPLE_TURN,
    });

    await loadStarted;
    const area = document.getElementById('chatArea');
    assert.equal(completionsStarted, false, 'completions must wait for model load');
    assert.match(area?.textContent ?? '', new RegExp(STREAM_LABEL_LOADING_MODEL));
    const streamRow = area?.querySelector('.msg.assistant') as HTMLElement | null;
    assert.equal(streamRow?.dataset.streamPhase, 'loading_model');

    releaseLoad();
    await turnPromise;
    assert.equal(completionsStarted, true);
  });
});
