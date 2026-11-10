/**
 * Boot resume gate only offers chats that belong to this window's workspace (MIN-532).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { scopeChatsToWindowWorkspace } from '../../src/boot/resume-gate-boot.ts';
import { declineChatAutoResume, isResumeGateHeld, setResumeGateState } from '../../src/chat/resume-gate.ts';
import type { Chat } from '../../src/types.ts';

function makeChat(id: string, workspacePath: string): Chat {
  return {
    id,
    name: id,
    workspacePath,
    modelId: 'm1',
    history: [],
    lastStats: null,
    modelInfo: {},
    updatedAt: 1,
    currentGenerationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  };
}

describe('scopeChatsToWindowWorkspace', () => {
  const chats = [
    makeChat('a', '/work/alpha'),
    makeChat('b', '/work/beta'),
    makeChat('legacy', ''),
  ];

  test('drops chats from other workspaces and unassigned chats', () => {
    assert.deepEqual(
      scopeChatsToWindowWorkspace(chats, '/work/beta').map((c) => c.id),
      ['b'],
    );
  });

  test('keeps every chat when the window has no workspace', () => {
    assert.equal(scopeChatsToWindowWorkspace(chats, '').length, 3);
  });
});

test('a partial resume keeps automatic work held only for declined threads', () => {
  try {
    setResumeGateState('pending');
    assert.equal(isResumeGateHeld('selected'), true);
    declineChatAutoResume('declined');
    setResumeGateState('resumed');
    assert.equal(isResumeGateHeld('selected'), false);
    assert.equal(isResumeGateHeld('declined'), true);
  } finally {
    setResumeGateState('idle');
  }
});
