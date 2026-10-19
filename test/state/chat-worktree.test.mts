/**
 * Pure helpers for per-chat worktree composer state (MIN-276).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  enableChatWorktreeOnSend,
  formatComposerBranchLabel,
  formatComposerRunTargetLabel,
  isChatWorktreeMode,
  isManagedChatWorktreePath,
  parseChatRunTargetChoice,
  applyChatRunTargetChoice,
  isChatWorktreeSetupPending,
  resolveChatSpawnCwd,
  resolveChatToolWorkspaceRoot,
  suggestChatWorktreeBranchName,
} from '../../src/state/chat-worktree.ts';
import { normalizeChatRow } from '../../src/state/session-schema.mjs';
import { setWorkspaceFromServer } from '../../src/state/workspace.ts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';

describe('chat-worktree helpers', () => {
  test('deferred selection survives normalization without creating a checkout', () => {
    setWorkspaceFromServer({ path: '/repo', label: 'repo', isDefault: false });
    const chat = { id: 'deferred-chat', workspacePath: '' } as never;
    enableChatWorktreeOnSend(chat);
    const restored = normalizeChatRow(JSON.parse(JSON.stringify(chat)));
    assert.equal(restored.worktreeEnabled, true);
    assert.equal(restored.workspacePath, '/repo');
    assert.equal(restored.worktreeRoot, undefined);
    assert.equal(restored.worktreeSetupRequired, undefined);
    restored.worktreeSetupRequired = true;
    assert.equal(normalizeChatRow(restored).worktreeSetupRequired, true);
    assert.equal(normalizeChatRow({ worktreeEnabled: 'true', worktreeSetupRequired: 1 }).worktreeEnabled, undefined);
    assert.equal(normalizeChatRow({ worktreeSetupRequired: 1 }).worktreeSetupRequired, undefined);
  });

  test('automatic setup coalesces, binds the originating repo, and Local preserves files', async () => {
    const originalFetch = globalThis.fetch;
    setLocalServerAvailableForTests(true);
    const calls: any[] = [];
    let complete!: (response: Response) => void;
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      if (body.op === 'enable_chat') return new Promise<Response>(resolve => { complete = resolve; });
      return Response.json({ ok: true, current: 'main' });
    }) as typeof fetch;
    const chat = { id: 'auto-test', name: 'Fix login', workspacePath: '/issue/repo', worktreeRoot: undefined as string | undefined, worktreeSetupRequired: undefined as boolean | undefined };
    try {
      assert.deepEqual(parseChatRunTargetChoice({ kind: 'automatic' }), { kind: 'automatic' });
      const first = applyChatRunTargetChoice(chat as never, { kind: 'automatic' });
      const duplicate = applyChatRunTargetChoice(chat as never, { kind: 'automatic' });
      assert.equal(first, duplicate);
      assert.equal(isChatWorktreeSetupPending(chat.id), true);
      assert.equal(chat.worktreeRoot, undefined);
      assert.equal(calls[0].cwd, '/issue/repo');
      complete(Response.json({ ok: true, path: '/managed/chat/auto-test', branch: 'minnow/fix-login-123' }));
      assert.equal((await first).ok, true);
      assert.equal(isChatWorktreeSetupPending(chat.id), false);
      assert.equal(chat.worktreeRoot, '/managed/chat/auto-test');
      assert.equal(chat.worktreeSetupRequired, undefined);
      await applyChatRunTargetChoice(chat as never, { kind: 'local' });
      assert.equal(chat.worktreeRoot, undefined);
      assert.equal(calls.some(c => c.op === 'remove_chat'), false);
      globalThis.fetch = (async () => Response.json({ ok: false, error: 'Install failed; worktree kept' })) as typeof fetch;
      assert.equal((await applyChatRunTargetChoice(chat as never, { kind: 'automatic' })).ok, false);
      assert.equal(chat.worktreeRoot, undefined);
      assert.equal(isChatWorktreeSetupPending(chat.id), false);
      assert.equal(chat.worktreeSetupRequired, true);
      const restored = JSON.parse(JSON.stringify(chat));
      assert.equal(restored.worktreeSetupRequired, true);
      await applyChatRunTargetChoice(restored, { kind: 'local' });
      assert.equal(restored.worktreeSetupRequired, undefined);
    } finally {
      globalThis.fetch = originalFetch;
      setLocalServerAvailableForTests(false);
    }
  });
  test('isChatWorktreeMode is true when worktreeRoot is set', () => {
    setWorkspaceFromServer({ path: '/repo/main', label: 'main', isDefault: false });
    assert.equal(isChatWorktreeMode({ worktreeRoot: '/tmp/wt' }), true);
    assert.equal(isChatWorktreeMode({ worktreeRoot: '' }), false);
    assert.equal(isChatWorktreeMode({}), false);
  });

  test('isChatWorktreeMode is false when worktreeRoot is only a casing twin of the workspace', () => {
    setWorkspaceFromServer({
      path: 'c:\\Users\\me\\repo',
      label: 'repo',
      isDefault: false,
    });
    assert.equal(isChatWorktreeMode({ worktreeRoot: 'C:/Users/me/repo' }), false);
  });

  test('formatComposerRunTargetLabel reflects worktree vs local', () => {
    setWorkspaceFromServer({ path: '/repo/main', label: 'main', isDefault: false });
    assert.equal(formatComposerRunTargetLabel({}), 'Local');
    assert.equal(formatComposerRunTargetLabel({ worktreeRoot: '/wt' }), 'Worktree');
  });

  test('formatComposerBranchLabel falls back to Branch', () => {
    assert.equal(formatComposerBranchLabel(), 'Branch');
    assert.equal(formatComposerBranchLabel('main'), 'main');
  });

  test('isManagedChatWorktreePath matches sanitized chat slot paths', () => {
    const chatId = 'chat-abc-123';
    const path = `/home/user/.minnow/worktrees/repo-hash/chat/${chatId}`;
    assert.equal(isManagedChatWorktreePath(chatId, path), true);
    assert.equal(isManagedChatWorktreePath(chatId, '/other/path'), false);
  });

  test('suggestChatWorktreeBranchName uses the chat title, not the current branch', () => {
    assert.equal(
      suggestChatWorktreeBranchName({
        name: 'Test Worktree',
        workspacePath: '/tmp/opaque-id',
        gitBranch: 'main',
      }),
      'test-worktree',
    );
  });

  test('suggestChatWorktreeBranchName skips placeholder chat names', () => {
    assert.equal(
      suggestChatWorktreeBranchName(
        { name: 'New chat', workspacePath: '', gitBranch: 'main' },
        '/Users/dev/Minnow',
      ),
      'minnow',
    );
  });

  test('parseChatRunTargetChoice accepts local, attach, and create payloads', () => {
    assert.deepEqual(parseChatRunTargetChoice({ kind: 'local' }), { kind: 'local' });
    assert.deepEqual(
      parseChatRunTargetChoice({ kind: 'attach', path: '/wt', branch: 'feat' }),
      { kind: 'attach', path: '/wt', branch: 'feat' },
    );
    assert.deepEqual(
      parseChatRunTargetChoice({
        kind: 'create',
        name: 'fix-login',
        startPoint: 'main',
        checkoutExisting: false,
      }),
      {
        kind: 'create',
        name: 'fix-login',
        startPoint: 'main',
        checkoutExisting: false,
      },
    );
    assert.equal(parseChatRunTargetChoice({ kind: 'attach', path: '  ' }), null);
    assert.equal(parseChatRunTargetChoice({ kind: 'nope' }), null);
  });

  test('applyChatRunTargetChoice attach stamps worktreeRoot before tools run', async () => {
    setWorkspaceFromServer({ path: '/repo/main', label: 'main', isDefault: false });
    const chat = { id: 'chat-1', worktreeRoot: undefined as string | undefined, gitBranch: 'main' };
    const res = await applyChatRunTargetChoice(chat as never, {
      kind: 'attach',
      path: '/repo/feature-wt',
      branch: 'feat/login',
    });
    assert.equal(res.ok, true);
    assert.equal(isChatWorktreeMode(chat), true);
    assert.equal(chat.gitBranch, 'feat/login');
  });

  test('resolveChatSpawnCwd prefers the chat worktree over workspacePath', () => {
    setWorkspaceFromServer({ path: '/repo/main', label: 'main', isDefault: false });
    assert.equal(
      resolveChatSpawnCwd({
        worktreeRoot: '/repo/wt',
        workspacePath: '/repo/main',
      }),
      '/repo/wt',
    );
    assert.equal(
      resolveChatSpawnCwd({ workspacePath: '/repo/main' }),
      '/repo/main',
    );
    assert.equal(resolveChatSpawnCwd(undefined), undefined);
  });

  test('background issue chats keep their own workspace and explicit checkout when Code uses another folder', async () => {
    setWorkspaceFromServer({ path: '/repo/main', label: 'main', isDefault: false });
    const chat = { id: 'issue-chat', workspacePath: '/repo/issue-workspace', background: true, worktreeRoot: undefined as string | undefined };
    assert.equal(resolveChatToolWorkspaceRoot(chat), '/repo/issue-workspace');
    await applyChatRunTargetChoice(chat as never, { kind: 'attach', path: '/repo/main', branch: 'main' });
    assert.equal(chat.worktreeRoot, '/repo/main');
    assert.equal(resolveChatToolWorkspaceRoot(chat), '/repo/main');
    assert.equal(isChatWorktreeMode(chat), true);
    await applyChatRunTargetChoice(chat as never, { kind: 'attach', path: '/repo/issue-workspace', branch: 'issue-base' });
    assert.equal(chat.worktreeRoot, undefined);
    assert.equal(resolveChatToolWorkspaceRoot(chat), '/repo/issue-workspace');
  });
});
