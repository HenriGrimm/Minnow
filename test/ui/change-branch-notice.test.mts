import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { Window } from 'happy-dom';
import type { Chat } from '../../src/types.ts';

const chats: Chat[] = [];
const running = new Set<string>();
const calls: unknown[][] = [];
let current = 'main';
let confirm = true;
let dirty = false;
let choice = 'leave';
let failure = '';
let remoteFailure = false;
let remoteChatId = '';
const chat = (id: string, workspacePath = '/repo', worktreeRoot?: string) => ({ id, workspacePath, worktreeRoot } as Chat);
mock.module('../../src/state/git-api.ts', { namedExports: {
  gitBranches: async (cwd: string) => { calls.push(['branches', cwd]); return { ok: true, current }; },
  gitCheckoutSwitch: async (input: { branch: string; dirtyHandling?: string }) => {
    calls.push(['switch', input]);
    if (failure) return { ok: false, error: failure };
    if (dirty && !input.dirtyHandling) return { ok: false, needsChoice: true, branch: current, fileCount: 2 };
    current = input.branch;
    return { ok: true, branch: current };
  },
} });
mock.module('../../src/state/workspace.ts', { namedExports: { getWorkspacePath: () => '/repo' } });
mock.module('../../src/state/sessions.ts', { namedExports: {
  sessionState: { chats }, touchChat() {}, scheduleSaveSessions() {},
} });
mock.module('../../src/chat/streaming-state.ts', { namedExports: { isChatStreaming: (id: string) => running.has(id) } });
mock.module('../../src/chat/turn-ownership.ts', { namedExports: { refreshRemoteChatTurns: async () => {
  if (remoteFailure) throw new Error('Could not check running chats.');
  if (remoteChatId) running.add(remoteChatId);
  return Boolean(remoteChatId);
} } });
mock.module('../../src/ui/app-dialog.ts', { namedExports: {
  appConfirm: async (message: string) => { calls.push(['confirm', message]); return confirm; },
  appChoice: async () => { calls.push(['choice']); return { id: choice }; },
} });
mock.module('../../src/ui/git-panel.ts', { namedExports: { refreshGitPanel: async () => { calls.push(['refresh']); } } });
mock.module('../../src/ui/composer-run-target.ts', { namedExports: { syncComposerRunTargetFromActiveChat() {} } });
const { createChangeBranchNotice, runningChatsInCheckout, switchToChangeBranch } = await import('../../src/ui/change-branch-notice.ts');
let win: Window;
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
const checkout = { workspacePath: '/repo', gitBranch: 'feature' };
beforeEach(() => {
  win = new Window();
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.document = win.document as unknown as Document;
  chats.splice(0); running.clear(); calls.splice(0);
  current = 'main'; confirm = true; dirty = false; choice = 'leave'; failure = ''; remoteFailure = false; remoteChatId = '';
});
afterEach(() => { globalThis.document = originalDocument; globalThis.window = originalWindow; win.close(); });

test('only running chats sharing the local checkout warn, with Windows path equality', () => {
  const all = [chat('local', 'C:/repo'), chat('worktree', 'C:/repo', 'C:/slots/one'), chat('other', 'C:/other'), chat('idle', 'C:/repo'), chat('case', 'c:\\REPO\\', 'C:/repo')];
  assert.deepEqual(runningChatsInCheckout(all, 'c:/repo', id => id !== 'idle').map(c => c.id), ['local', 'case']);
});
test('cancelling the active-chat warning prevents any checkout', async () => {
  chats.push(chat('local')); running.add('local'); confirm = false;
  assert.equal(await switchToChangeBranch(checkout), false);
  assert.equal(calls.some(c => c[0] === 'switch'), false);
  assert.match(calls.find(c => c[0] === 'confirm')![1] as string, /1 chat is running/);
});
test('isolated and other-project runs do not prompt, and successful switch refreshes UI', async () => {
  chats.push(chat('worktree', '/repo', '/slots/one'), chat('other', '/elsewhere'));
  running.add('worktree'); running.add('other');
  assert.equal(await switchToChangeBranch(checkout), true);
  assert.equal(calls.some(c => c[0] === 'confirm'), false);
  assert.equal(calls.some(c => c[0] === 'refresh'), true);
  assert.deepEqual(calls.find(c => c[0] === 'switch')![1], { cwd: '/repo', branch: 'feature', expectedBranch: 'main' });
});
test('dirty files retain the explicit bring/leave choice and cancellation', async () => {
  dirty = true; choice = 'cancel';
  assert.equal(await switchToChangeBranch(checkout), false);
  assert.equal(current, 'main');
  calls.splice(0); choice = 'leave';
  assert.equal(await switchToChangeBranch(checkout), true);
  assert.deepEqual(calls.filter(c => c[0] === 'switch').at(-1)![1], {
    cwd: '/repo', branch: 'feature', expectedBranch: 'main', dirtyHandling: 'leave',
  });
});
test('preview shows both branches, offers switch, then reflects the successful checkout', async () => {
  const notice = createChangeBranchNotice([checkout], chat('viewer'));
  document.body.append(notice);
  await settle();
  assert.match(notice.textContent!, /made on feature.*checkout is on main/);
  const button = notice.querySelector('button')!;
  assert.equal(button.hidden, false);
  button.click(); await settle();
  assert.equal(current, 'feature');
  assert.equal(button.hidden, true);
  assert.match(notice.textContent!, /same branch/);
});
test('failed checkout stays visible with retry and never reports success', async () => {
  failure = 'Branch feature is checked out in another worktree';
  const notice = createChangeBranchNotice([checkout], chat('viewer'));
  await settle();
  const button = notice.querySelector('button')!;
  button.click(); await settle();
  assert.match(notice.textContent!, /another worktree/);
  assert.equal(button.disabled, false);
  assert.equal(current, 'main');
});
test('legacy changes never borrow the current chat branch; detached HEAD has no switch', () => {
  const viewer = { ...chat('viewer'), gitBranch: 'wrong-branch' };
  const legacy = createChangeBranchNotice([{}], viewer);
  assert.match(legacy.textContent!, /not recorded/);
  assert.doesNotMatch(legacy.textContent!, /wrong-branch/);
  assert.equal(legacy.querySelector('button'), null);
  const detached = createChangeBranchNotice([{ ...checkout, gitBranch: 'HEAD' }], viewer);
  assert.match(detached.textContent!, /detached HEAD/);
  assert.equal(detached.querySelector('button'), null);
});
test('remote activity is refreshed before warning and a failed activity check prevents checkout', async () => {
  chats.push(chat('remote')); remoteChatId = 'remote'; confirm = false;
  assert.equal(await switchToChangeBranch(checkout), false);
  assert.equal(calls.some(c => c[0] === 'confirm'), true);
  assert.equal(calls.some(c => c[0] === 'switch'), false);
  remoteFailure = true;
  await assert.rejects(switchToChangeBranch(checkout), /Could not check running chats/);
  assert.equal(calls.some(c => c[0] === 'switch'), false);
});
test('live notice refresh reflects external branch changes', async () => {
  current = 'feature';
  const notice = createChangeBranchNotice([checkout], chat('viewer'));
  await settle();
  assert.equal(notice.querySelector('button')!.hidden, true);
  current = 'other';
  notice.dispatchEvent(new win.Event('minnow:refresh-change-branches') as unknown as Event);
  await settle();
  assert.equal(notice.querySelector('button')!.hidden, false);
  assert.match(notice.textContent!, /checkout is on other/);
});
