import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import type { Chat } from '../../src/types.ts';

let chat: Chat;
let workspace = '/repo';
let busy = false;
let readOnly = false;
let branch = 'feature';
let creationError = '';
const calls: { kind: string; args: unknown[] }[] = [];
mock.module('../../src/state/sessions.ts', { namedExports: {
  sessionState: { activeId: 'current', groups: [] }, getActiveChat: () => chat,
} });
mock.module('../../src/state/workspace.ts', { namedExports: { getWorkspacePath: () => workspace } });
mock.module('../../src/state/chat-worktree.ts', { namedExports: { resolveChatToolWorkspaceRoot: (value: Chat) => value.worktreeRoot } });
mock.module('../../src/chat/chat-turn-guard.ts', { namedExports: { isChatTurnInProgress: () => busy } });
mock.module('../../src/state/chat-relationships.ts', { namedExports: {
  chatReadOnlyReason: () => readOnly ? 'Inspect only' : null,
  hasUnsettledAgentWork: () => busy,
} });
mock.module('../../src/state/git-api.ts', { namedExports: { gitStatus: async (cwd: string) => {
  calls.push({ kind: 'status', args: [cwd] }); return { ok: true, branch };
} } });
mock.module('../../src/ui/code-overview.ts', { namedExports: { isCodeOverviewOpen: () => false, closeCodeOverview() {} } });
mock.module('../../src/os/router.ts', { namedExports: { navigateToCodeChat() { calls.push({ kind: 'navigate', args: [] }); } } });
mock.module('../../src/ui/sidebar.ts', { namedExports: { createChatWithMode: async (options: unknown) => {
  calls.push({ kind: 'create', args: [options] });
  return creationError ? { ok: false, error: creationError } : { ok: true, chatId: 'new-fix' };
} } });
mock.module('../../src/chat/messaging.ts', { namedExports: { sendProgrammaticChatText: async (value: Chat, text: string, options: { onUserMessageAccepted: () => Promise<void> }) => {
  calls.push({ kind: 'send', args: [value.id, text, options] });
  await options.onUserMessageAccepted();
} } });
mock.module('../../src/ui/toast.ts', { namedExports: { showToast() {} } });
const { getGitErrorCurrentChat, sendGitErrorToChat, buildGitErrorFixSeedMessage } = await import('../../src/ui/git-error-to-chat.ts');
const ctx = { cwd: '/repo/.worktrees/feature', workspacePath: '/repo', branch: 'feature', operation: 'merge' as const, conflictedFiles: ['src/search.ts'], reviewBeforeFinish: true };
beforeEach(() => {
  workspace = '/repo'; busy = false; readOnly = false; branch = 'feature'; creationError = ''; calls.length = 0;
  chat = { id: 'current', name: 'Build search', modeId: 'build', workspacePath: '/repo', worktreeRoot: ctx.cwd, gitBranch: 'feature' } as Chat;
});

test('only an idle writable Build chat in the failed checkout is eligible', async () => {
  assert.deepEqual(await getGitErrorCurrentChat(ctx), { id: 'current', name: 'Build search' });
  busy = true; assert.equal(await getGitErrorCurrentChat(ctx), null); busy = false;
  readOnly = true; assert.equal(await getGitErrorCurrentChat(ctx), null); readOnly = false;
  chat.modeId = 'plan'; assert.equal(await getGitErrorCurrentChat(ctx), null); chat.modeId = 'build';
  chat.worktreeRoot = '/another-checkout'; assert.equal(await getGitErrorCurrentChat(ctx), null);
});

test('current chat handoff uses the shared send engine without clearing composer drafts', async () => {
  assert.equal(await sendGitErrorToChat('pull', 'CONFLICT in src/search.ts', ctx, 'current'), 'current');
  assert.deepEqual(calls.find(call => call.kind === 'status')?.args, [ctx.cwd]);
  const delivery = calls.find(call => call.kind === 'send')!;
  assert.equal(delivery.args[0], 'current');
  assert.match(delivery.args[1] as string, /src\/search.ts/);
  assert.equal((delivery.args[2] as { clearComposerOnSend: boolean }).clearComposerOnSend, false);
  assert.equal(calls.some(call => call.kind === 'create'), false);
});

test('new recovery chat is pinned to the captured checkout before the seeded turn', async () => {
  assert.equal(await sendGitErrorToChat('merge', 'CONFLICT', ctx), 'new-fix');
  assert.deepEqual((calls.find(call => call.kind === 'create')!.args[0] as { gitRecoveryTarget: unknown }).gitRecoveryTarget,
    { cwd: ctx.cwd, branch: 'feature' });
  assert.equal((calls.find(call => call.kind === 'create')!.args[0] as { workspacePath: string }).workspacePath, '/repo');
});

test('a changed workspace, changed branch, busy chat, or creation failure is reported instead of silently sending elsewhere', async () => {
  workspace = '/other'; await assert.rejects(sendGitErrorToChat('merge', 'CONFLICT', ctx), /workspace changed/);
  workspace = '/repo'; branch = 'other'; await assert.rejects(sendGitErrorToChat('merge', 'CONFLICT', ctx), /changed branches/);
  branch = 'feature'; busy = true; await assert.rejects(sendGitErrorToChat('merge', 'CONFLICT', ctx, 'current'), /busy/);
  busy = false; creationError = 'Select a model first'; await assert.rejects(sendGitErrorToChat('merge', 'CONFLICT', ctx), /Select a model/);
  assert.equal(calls.some(call => call.kind === 'send'), false);
});

test('recovery seed preserves unrelated work and leaves final merge review to the user', () => {
  const seed = buildGitErrorFixSeedMessage('pull', 'CONFLICT', ctx);
  assert.match(seed, /Paused operation: merge/);
  assert.match(seed, /all unrelated local work/);
  assert.match(seed, /Leave the final merge commit/);
  assert.doesNotMatch(seed, /finish the merge commit/);
});
