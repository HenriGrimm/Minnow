import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import { setIssuesStateForTests } from '../../src/state/issues-store.ts';
import { setWorkspaceFromServer } from '../../src/state/workspace.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { initComposerRunTarget } from '../../src/ui/composer-run-target.ts';
import { issueUsesWorktree, toggleIssueWorktree, promptIssueChatRunTarget } from '../../src/ui/issues-chat-run-target.ts';

test('composer enables directly, shows progress, and retains the original chat on a switch', async () => {
  const dom = new Window();
  let complete!: (response: Response) => void;
  const requests: any[] = [];
  installHappyDomGlobals(dom, { fetch: (async (_url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    requests.push(body);
    if (body.op === 'enable_chat') return new Promise<Response>(resolve => { complete = resolve; });
    return Response.json({ ok: true, current: 'main' });
  }) as typeof fetch });
  setStorageModeForTests('localStorage');
  globalThis.CustomEvent = dom.CustomEvent as typeof CustomEvent;
  setLocalServerAvailableForTests(true);
  setWorkspaceFromServer({ path: '/repo', label: 'repo', isDefault: false });
  const chat = createEmptyChatObject('model', '/repo');
  chat.gitBranch = 'main';
  const other = createEmptyChatObject('model', '/other');
  other.gitBranch = 'main';
  setSessionStateForTests({ chats: [chat, other], activeId: chat.id });
  document.body.innerHTML = '<div id="composerControls"></div>';
  try {
    initComposerRunTarget();
    const enable = document.getElementById('composerRunTargetBtn') as HTMLButtonElement;
    assert.equal(enable.textContent, 'Enable worktree');
    enable.click();
    enable.click();
    assert.equal(requests.filter(r => r.op === 'enable_chat').length, 1);
    assert.equal(enable.disabled, true);
    assert.equal(enable.textContent, 'Setting up…');
    assert.equal(document.querySelector('.git-panel-name-popover'), null);
    setSessionStateForTests({ chats: [chat, other], activeId: other.id });
    complete(Response.json({ ok: true, path: '/managed/chat/test', branch: 'minnow/auto-test' }));
    for (let i = 0; i < 50 && enable.disabled; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(chat.worktreeRoot, '/managed/chat/test');
    assert.equal(other.worktreeRoot, undefined);
    assert.equal(enable.textContent, 'Enable worktree');
  } finally {
    setLocalServerAvailableForTests(false);
    await teardownHappyDomAsync(dom);
  }
});

test('issue preference launches directly and never falls back to Local when server is unavailable', async () => {
  const dom = new Window();
  installHappyDomGlobals(dom);
  setLocalServerAvailableForTests(false);
  const issue = { id: 'MIN-999', title: 'Fix login', description: '', type: 'bug', status: 'todo', priority: 'medium', labels: [], workspacePath: '/issue-repo', createdAt: 1, updatedAt: 1 };
  setIssuesStateForTests({ version: 2, nextId: 1000, issues: [issue] } as never);
  try {
    const choices: unknown[] = [];
    assert.equal(issueUsesWorktree(issue.id), false);
    toggleIssueWorktree(issue.id);
    promptIssueChatRunTarget({ issueId: issue.id, onPick: choice => { choices.push(choice); } });
    assert.deepEqual(choices, [{ kind: 'automatic' }]);
    assert.equal(document.querySelector('.composer-run-target-menu'), null);
    toggleIssueWorktree(issue.id);
    promptIssueChatRunTarget({ issueId: issue.id, onPick: choice => { choices.push(choice); } });
    assert.deepEqual(choices[1], { kind: 'local' });
  } finally {
    setIssuesStateForTests(null);
    await teardownHappyDomAsync(dom);
  }
});

test('a restored failed setup blocks programmatic sends before any agent work', async () => {
  const dom = new Window();
  installHappyDomGlobals(dom);
  try {
    const chat = createEmptyChatObject('model', '/repo');
    chat.worktreeSetupRequired = true;
    const restored = JSON.parse(JSON.stringify(chat));
    const { sendProgrammaticChatText } = await import('../../src/chat/messaging.ts');
    await assert.rejects(sendProgrammaticChatText(restored, 'Change a file'), /Retry worktree setup/);
    assert.equal(restored.history.length, 0);
  } finally {
    await teardownHappyDomAsync(dom);
  }
});
