/**
 * Renderer permission gate: one system-wide level decides through the shared
 * classifier; chat grants and turn clamps narrow or widen single calls.
 *
 * No DOM here, so any call that would show the approval card returns the
 * "needs approval" error instead — which is exactly what these tests assert.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  addChatPermissionGrant,
  blockAfkInteractionAttempt,
  classifyForGate,
  getChatPermissionGrants,
  isExternalCallApproved,
  maybeBlockToolForUserApproval,
} from '../../src/tools/permission-gate.ts';
import { defaultToolConfig, setToolConfigForTests } from '../../src/tools/config.ts';
import {
  applyRemoteToolSecurityMeta,
  resetToolSecurityMetaCache,
} from '../../src/config/tool-security-meta.ts';
import {
  createEmptyChatObject,
  flushScheduledSessionSaveForTests,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';

const WS = '/tmp/minnow-gate-ws';

function setLevel(level: 'manual' | 'auto' | 'full'): void {
  applyRemoteToolSecurityMeta({ permissionLevel: level });
}

function seedChat(id = 'chat-gate'): string {
  const chat = createEmptyChatObject('model', WS);
  chat.id = id;
  setSessionStateForTests({ version: 5, activeId: chat.id, chats: [chat], groups: [] });
  return chat.id;
}

beforeEach(() => {
  resetToolSecurityMetaCache();
  const config = defaultToolConfig();
  setToolConfigForTests(config);
});

afterEach(() => {
  flushScheduledSessionSaveForTests();
  setSessionStateForTests(null);
  setToolConfigForTests(defaultToolConfig());
  resetToolSecurityMetaCache();
});

describe('classifyForGate', () => {
  test('uses the context workspace for in/out of project decisions', () => {
    const inside = classifyForGate('read_file', { path: 'src/a.ts' }, { workspaceRoot: WS });
    assert.equal(inside.kind, 'read');
    assert.equal(inside.external, false);
    const outside = classifyForGate('read_file', { path: '/etc/hosts' }, { workspaceRoot: WS });
    assert.equal(outside.external, true);
  });
});

describe('maybeBlockToolForUserApproval', () => {
  test('legacy per-tool Off cannot override global Full access', async () => {
    const config = defaultToolConfig();
    Object.assign(config, { enabled: { save_file: false }, permissions: { default: { save_file: 'off' } } });
    setToolConfigForTests(config);
    setLevel('full');
    const result = await maybeBlockToolForUserApproval('save_file', { path: 'a.ts', content: '' }, { workspaceRoot: WS });
    assert.equal(result, null);
  });

  test('reads inside the project never ask, even in Manual', async () => {
    setLevel('manual');
    const result = await maybeBlockToolForUserApproval('read_file', { path: 'src/a.ts' }, { workspaceRoot: WS });
    assert.equal(result, null);
  });

  test('Manual asks before an in-project edit', async () => {
    setLevel('manual');
    const result = await maybeBlockToolForUserApproval('save_file', { path: 'src/a.ts', content: 'x' }, { workspaceRoot: WS });
    assert.match(result?.content ?? '', /needs approval/);
  });

  test('Auto allows a routine edit and asks before a destructive command', async () => {
    setLevel('auto');
    assert.equal(
      await maybeBlockToolForUserApproval('save_file', { path: 'src/a.ts', content: 'x' }, { workspaceRoot: WS }),
      null,
    );
    const risky = await maybeBlockToolForUserApproval('execute_command', { command: 'git push --force' }, { workspaceRoot: WS });
    assert.match(risky?.content ?? '', /needs approval/);
  });

  test('Full allows outside-project edits and marks the call for the server', async () => {
    setLevel('full');
    const args = { path: '/tmp/elsewhere/notes.md', content: 'x' };
    assert.equal(await maybeBlockToolForUserApproval('save_file', args, { workspaceRoot: WS }), null);
    assert.equal(isExternalCallApproved(args), true);
  });

  test('Full still denies the secret floor', async () => {
    setLevel('full');
    const result = await maybeBlockToolForUserApproval(
      'read_file',
      { path: '~/.minnow/.key' },
      { workspaceRoot: WS },
    );
    assert.match(result?.content ?? '', /^Error:/);
  });

  test('a read-only clamp denies edits whatever the level', async () => {
    setLevel('full');
    const result = await maybeBlockToolForUserApproval(
      'save_file',
      { path: 'src/a.ts', content: 'x' },
      { workspaceRoot: WS, turnClamp: 'read-only' },
    );
    assert.match(result?.content ?? '', /^Error:/);
  });

  test('the plans clamp allows plan files only', async () => {
    setLevel('auto');
    assert.equal(
      await maybeBlockToolForUserApproval(
        'save_file',
        { path: 'documentation/plans/x.md', content: '# x' },
        { workspaceRoot: WS, turnClamp: 'plans' },
      ),
      null,
    );
    const blocked = await maybeBlockToolForUserApproval(
      'save_file',
      { path: 'src/a.ts', content: 'x' },
      { workspaceRoot: WS, turnClamp: 'plans' },
    );
    assert.match(blocked?.content ?? '', /^Error:/);
  });

  test('an "Allow for this chat" grant skips the prompt for matching calls', async () => {
    setLevel('manual');
    const chatId = seedChat();
    const args = { command: 'npm test' };
    const action = classifyForGate('execute_command', args, { workspaceRoot: WS });
    assert.ok(action.grant, 'shell commands carry a grant key');
    assert.match(
      (await maybeBlockToolForUserApproval('execute_command', args, { workspaceRoot: WS, chatId }))?.content ?? '',
      /needs approval/,
    );
    addChatPermissionGrant(chatId, action.grant!.key);
    assert.deepEqual(getChatPermissionGrants(chatId), [action.grant!.key]);
    assert.equal(await maybeBlockToolForUserApproval('execute_command', args, { workspaceRoot: WS, chatId }), null);
  });

  test('benchmark runs proceed as Full access', async () => {
    setLevel('manual');
    const result = await maybeBlockToolForUserApproval(
      'save_file',
      { path: 'src/a.ts', content: 'x' },
      { workspaceRoot: WS, benchmarkAutonomous: true },
    );
    assert.equal(result, null);
  });
});

describe('blockAfkInteractionAttempt', () => {
  test('never blocks (board-managed chats use the same level)', () => {
    assert.equal(blockAfkInteractionAttempt({ chatId: 'x' }, 'question', 'ask_question'), null);
  });
});
