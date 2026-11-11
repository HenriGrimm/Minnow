/**
 * First-turn injection gating for Brain notes, code map, and context documents.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { shouldRunFirstTurnInjections } from '../../src/chat/prompts/first-turn-injection.ts';
import {
  buildComposeContext,
  resolveOutboundSystemMessages,
} from '../../src/chat/prompts/compose-context.ts';
import { composeSystemPrompt } from '../../src/chat/prompts/prompt-composer.ts';
import { appendInjectionNoticesForTurn } from '../../src/chat/context/injection-notice.ts';
import {
  DEFAULT_PROMPT_META,
  resetPromptMetaCache,
  setPromptMetaCacheForTests,
} from '../../src/config/prompt-meta.ts';
import { setSessionStateForTests } from '../../src/state/sessions.ts';
import {
  resetWorkspaceStateForTests,
  setWorkspaceFromServer,
} from '../../src/state/workspace.ts';
import type { Chat } from '../../src/types.ts';

function chatWithHistory(roles: Array<'user' | 'assistant'>): Chat {
  return {
    id: 'c1',
    name: 'Test',
    history: roles.map((role) =>
      role === 'user'
        ? { role: 'user', content: 'hi' }
        : { role: 'assistant', content: 'ok' },
    ),
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('shouldRunFirstTurnInjections', () => {
  test('runs when no user messages yet (token estimate path)', () => {
    const chat = chatWithHistory([]);
    assert.equal(shouldRunFirstTurnInjections(chat), true);
  });

  test('skips after first user message without firstUserSend flag', () => {
    const chat = chatWithHistory(['user']);
    assert.equal(shouldRunFirstTurnInjections(chat), false);
  });

  test('firstUserSend true forces inject even with user in history', () => {
    const chat = chatWithHistory(['user']);
    assert.equal(shouldRunFirstTurnInjections(chat, { firstUserSend: true }), true);
  });

  test('firstUserSend false forces skip on pending first user', () => {
    const chat = chatWithHistory([]);
    assert.equal(shouldRunFirstTurnInjections(chat, { firstUserSend: false }), false);
  });

  test('skips when lazy history is unloaded but messageCount shows prior turns', () => {
    const chat: Chat = {
      ...chatWithHistory([]),
      historyLoaded: false,
      messageCount: 4,
    };
    assert.equal(shouldRunFirstTurnInjections(chat), false);
  });
});

describe('injection replay on later turns', () => {
  const CHAT_ID = '22222222-2222-2222-2222-222222222222';
  const WORKSPACE = 'C:/Users/dukky/Documents/Development/Minnow';
  const STORED_DOCS = 'AGENTS.md says: never re-add repetition_penalty.';

  function chatWithStoredInjection(overrides: Partial<Chat> = {}): Chat {
    return {
      id: CHAT_ID,
      name: 'Test',
      modeId: 'build',
      history: [
        { role: 'user', content: 'first question' },
        { role: 'injection', kind: 'context-documents', body: STORED_DOCS, createdAt: 1 },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' },
      ],
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    };
  }

  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    // No config server here: 404 makes every loader take its documented default,
    // and stops experts-config rethrowing on the relative URL.
    realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, { status: 404 })) as typeof globalThis.fetch;
    resetPromptMetaCache();
    setPromptMetaCacheForTests({ ...DEFAULT_PROMPT_META });
    resetWorkspaceStateForTests();
    setWorkspaceFromServer({ path: WORKSPACE, label: 'Minnow', isDefault: false });
    setSessionStateForTests(null);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetPromptMetaCache();
    resetWorkspaceStateForTests();
    setSessionStateForTests(null);
  });

  test('turn 2 rehydrates the stored body into the composed prompt', async () => {
    const ctx = await buildComposeContext(chatWithStoredInjection());
    assert.equal(ctx.contextDocumentsBlock, STORED_DOCS);
    assert.equal(ctx.contextDocumentsInjectionEnabled, true);
    assert.equal(ctx.injectionsReplayed, true);
    assert.ok(composeSystemPrompt(ctx).includes(STORED_DOCS));
  });

  test('a source switched off mid-chat is not rehydrated', async () => {
    const ctx = await buildComposeContext(
      chatWithStoredInjection({ contextDocumentsInjection: 'off' }),
    );
    assert.equal(ctx.contextDocumentsBlock, null);
    assert.equal(ctx.contextDocumentsInjectionEnabled, false);
    assert.equal(ctx.injectionsReplayed, false);
  });

  test('a replayed turn reports no injection blocks, so no duplicate transcript row', async () => {
    const chat = chatWithStoredInjection();
    const outbound = await resolveOutboundSystemMessages(chat);
    assert.ok(outbound.composed.includes(STORED_DOCS));
    assert.deepEqual(outbound.injectionBlocks, {
      brainNotes: null,
      codeMap: null,
      contextDocuments: null,
    });
    assert.deepEqual(appendInjectionNoticesForTurn(chat, outbound.injectionBlocks), []);
    assert.equal(chat.history.filter((m) => m.role === 'injection').length, 1);
  });

  test('turn 2 keeps a stored body even when it would have exceeded the old 20% window share', async () => {
    const stored = 'x'.repeat(40_000);
    const chat = chatWithStoredInjection({
      history: [
        { role: 'user', content: 'first question' },
        {
          role: 'injection',
          kind: 'context-documents',
          body: stored,
          createdAt: 1,
        },
        { role: 'assistant', content: 'first answer' },
      ],
    });
    const ctx = await buildComposeContext(chat, { modelContextLimit: 8_000 });
    assert.equal(ctx.contextDocumentsBlock, stored);
    assert.equal(ctx.injectionsReplayed, true);
  });

  test('turn 2 replays code map and brain notes without live Brain/memory gates', async () => {
    const notes = 'wiki note from first turn';
    const map = 'src/chat/prompts/compose-context.ts:80';
    const chat = chatWithStoredInjection({
      codeMapInjection: 'on',
      brainNotesInjection: 'on',
      history: [
        { role: 'user', content: 'first question' },
        { role: 'injection', kind: 'brain-notes', body: notes, createdAt: 1 },
        { role: 'injection', kind: 'code-map', body: map, createdAt: 1 },
        { role: 'assistant', content: 'first answer' },
      ],
    });
    const ctx = await buildComposeContext(chat);
    assert.equal(ctx.memoryBlock, notes);
    assert.equal(ctx.codeMapBlock, map);
    assert.equal(ctx.injectionsReplayed, true);
    const composed = composeSystemPrompt(ctx);
    assert.ok(composed.includes(notes));
    assert.ok(composed.includes(map));
  });

  test('turn 2 sends the whole code map, not the transcript-capped copy', async () => {
    const map = 'm'.repeat(40_000);
    const chat = chatWithStoredInjection({
      codeMapInjection: 'on',
      history: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
      ],
    });
    // Turn 1: retrieve → transcript row (bounded) + snapshot (whole).
    appendInjectionNoticesForTurn(chat, {
      brainNotes: null,
      codeMap: map,
      contextDocuments: null,
    });
    chat.history.push({ role: 'user', content: 'second question' });

    const ctx = await buildComposeContext(chat);
    assert.equal(ctx.codeMapBlock, map);
    assert.equal(ctx.injectionsReplayed, true);
    assert.ok(composeSystemPrompt(ctx).includes(map));
  });

  test('turn 2 replays from chat.injectedContext when history rows are missing', async () => {
    const map = 'src/missing-row.ts:1';
    const chat = chatWithStoredInjection({
      codeMapInjection: 'on',
      injectedContext: { 'code-map': map },
      history: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
      ],
    });
    const ctx = await buildComposeContext(chat);
    assert.equal(ctx.codeMapBlock, map);
    assert.equal(ctx.injectionsReplayed, true);
  });
});
