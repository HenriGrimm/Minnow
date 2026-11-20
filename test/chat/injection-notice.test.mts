/**
 * Injection notice persistence.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  appendInjectionNoticesForTurn,
  injectionNoticeAction,
  injectionNoticeLabel,
  injectionNoticeOutcome,
  isTruncatedInjectionBody,
} from '../../src/chat/context/injection-notice.ts';
import { historyToApiMessagesForEstimate } from '../../src/chat/prompts/token-estimate-core.ts';
import type { Chat } from '../../src/types.ts';

describe('injection notice', () => {
  test('injectionNoticeLabel uses ellipsis copy', () => {
    assert.equal(injectionNoticeLabel('brain-notes'), 'Brain notes injected…');
    assert.equal(injectionNoticeLabel('code-map'), 'Code map injected…');
    assert.equal(injectionNoticeLabel('context-documents'), 'Context documents injected…');
  });

  test('injectionNoticeAction and outcome format transcript row copy', () => {
    assert.equal(injectionNoticeAction('brain-notes'), 'Brain notes');
    assert.equal(injectionNoticeAction('code-map'), 'Code map');
    assert.equal(injectionNoticeOutcome('one line'), '1 line');
    assert.equal(injectionNoticeOutcome('a\nb\nc'), '3 lines');
    assert.equal(injectionNoticeOutcome('   '), 'Injected');
  });

  test('appendInjectionNoticesForTurn adds rows when blocks are non-empty', () => {
    const chat: Chat = {
      id: 'c1',
      name: 'Test',
      history: [{ role: 'user', content: 'hello' }],
      createdAt: 1,
      updatedAt: 1,
    };
    const added = appendInjectionNoticesForTurn(chat, {
      brainNotes: null,
      codeMap: 'export function main() {}',
      contextDocuments: 'AGENTS.md body',
    });
    assert.equal(added.length, 2);
    assert.equal(chat.history.length, 3);
    assert.equal(chat.history[1].role, 'injection');
    if (chat.history[1].role === 'injection') {
      assert.equal(chat.history[1].kind, 'code-map');
      assert.equal(chat.history[1].body, 'export function main() {}');
    }
    assert.equal(chat.history[2].role, 'injection');
  });

  test('appendInjectionNoticesForTurn never records memory as injected', () => {
    const chat: Chat = { id: 'c-mem', name: 'Test', history: [{ role: 'user', content: 'hello' }], createdAt: 1, updatedAt: 1 };
    const added = appendInjectionNoticesForTurn(chat, { brainNotes: 'stale wiki hit', codeMap: null, contextDocuments: null });
    assert.equal(added.length, 0);
    assert.equal(chat.history.length, 1);
    assert.equal(chat.injectedContext?.['brain-notes'], undefined);
  });

  test('appendInjectionNoticesForTurn skips empty blocks', () => {
    const chat: Chat = {
      id: 'c2',
      name: 'Test',
      history: [{ role: 'user', content: 'hello' }],
      createdAt: 1,
      updatedAt: 1,
    };
    const added = appendInjectionNoticesForTurn(chat, {
      brainNotes: '   ',
      codeMap: null,
      contextDocuments: null,
    });
    assert.equal(added.length, 0);
    assert.equal(chat.history.length, 1);
  });

  test('appendInjectionNoticesForTurn dedupes identical consecutive notices', () => {
    const chat: Chat = {
      id: 'c3',
      name: 'Test',
      history: [{ role: 'user', content: 'hello' }],
      createdAt: 1,
      updatedAt: 1,
    };
    appendInjectionNoticesForTurn(chat, { brainNotes: null, codeMap: 'same', contextDocuments: null });
    appendInjectionNoticesForTurn(chat, { brainNotes: null, codeMap: 'same', contextDocuments: null });
    assert.equal(chat.history.length, 2);
  });

  test('a body over the storage cap is cut for the transcript but kept whole for replay', () => {
    const map = 'm'.repeat(40_000);
    const chat: Chat = {
      id: 'c4',
      name: 'Test',
      history: [{ role: 'user', content: 'hello' }],
      createdAt: 1,
      updatedAt: 1,
    };
    appendInjectionNoticesForTurn(chat, {
      brainNotes: null,
      codeMap: map,
      contextDocuments: null,
    });

    const row = chat.history[1];
    assert.equal(row.role, 'injection');
    if (row.role === 'injection') {
      assert.ok(row.body.length < map.length, 'transcript row stays bounded');
      assert.equal(row.truncated, true);
      assert.ok(isTruncatedInjectionBody(row.body));
    }
    // Replay reads the snapshot, so turn 2 must send the same bytes as turn 1.
    assert.equal(chat.injectedContext?.['code-map'], map);
  });

  test('a body under the storage cap is not flagged truncated', () => {
    const chat: Chat = {
      id: 'c5',
      name: 'Test',
      history: [{ role: 'user', content: 'hello' }],
      createdAt: 1,
      updatedAt: 1,
    };
    appendInjectionNoticesForTurn(chat, {
      brainNotes: null,
      codeMap: 'map hit',
      contextDocuments: null,
    });
    const row = chat.history[1];
    if (row.role === 'injection') {
      assert.equal(row.truncated, undefined);
    }
    assert.equal(chat.injectedContext?.['code-map'], 'map hit');
  });

  test('historyToApiMessagesForEstimate skips injection notices', () => {
    const api = historyToApiMessagesForEstimate([
      { role: 'user', content: 'hello' },
      {
        role: 'injection',
        kind: 'brain-notes',
        body: 'hidden',
        createdAt: 1,
      },
      { role: 'assistant', content: 'hi' },
    ]);
    assert.deepEqual(
      api.map((m) => m.role),
      ['user', 'assistant'],
    );
  });
});
