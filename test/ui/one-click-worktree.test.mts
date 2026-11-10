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

test('composer enables without setup and lets the user return to Local before sending', async () => {
  const dom = new Window();
  const requests: any[] = [];
  installHappyDomGlobals(dom, { fetch: (async (_url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    requests.push(body);
    return Response.json({ ok: true, current: 'main' });
  }) as typeof fetch });
  setStorageModeForTests('localStorage');
  globalThis.CustomEvent = dom.CustomEvent as typeof CustomEvent;
  setLocalServerAvailableForTests(true);
  setWorkspaceFromServer({ path: '/repo', label: 'repo', isDefault: false });
  const chat = createEmptyChatObject('model', '/repo');
  chat.gitBranch = 'main';
  setSessionStateForTests({ chats: [chat], activeId: chat.id });
  document.body.innerHTML = '<div id="composerControls"></div>';
  try {
    initComposerRunTarget();
    const enable = document.getElementById('composerRunTargetBtn') as HTMLButtonElement;
    assert.equal(enable.textContent, '');
    assert.equal(enable.getAttribute('aria-label'), 'Enable worktree');
    enable.click();
    assert.equal(requests.filter(r => r.op === 'enable_chat').length, 0);
    assert.equal(chat.worktreeEnabled, true);
    assert.equal(chat.worktreeRoot, undefined);
    assert.equal(enable.disabled, false);
    assert.equal(enable.textContent, 'Worktree');
    assert.equal(enable.getAttribute('aria-pressed'), 'true');
    assert.match(enable.title, /next message/);
    assert.equal(document.querySelector('.git-panel-name-popover'), null);
    enable.click();
    for (let i = 0; i < 40 && !document.querySelector('#composerRunTargetMenu button'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const items = [...document.querySelectorAll<HTMLButtonElement>('#composerRunTargetMenu button')];
    assert.equal(items.find(item => item.textContent === 'Worktree enabled · creates on send')?.disabled, true);
    assert.equal(items.some(item => item.textContent?.includes('Switch branch')), false);
    items.find(item => item.textContent === 'Back to Local')!.click();
    for (let i = 0; i < 40 && enable.disabled; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(chat.worktreeEnabled, undefined);
    assert.equal(enable.getAttribute('aria-label'), 'Enable worktree');
    assert.equal(requests.some(r => r.op === 'enable_chat'), false);
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

test('one worktree control switches branches in its checkout and returns to Local', async () => {
  const dom = new Window();
  const requests: Record<string, any>[] = [];
  const chat = createEmptyChatObject('model', '/repo');
  chat.worktreeRoot = '/repo/login-fix';
  chat.gitBranch = 'fix/login';
  const porcelain = 'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/login-fix\nHEAD def\nbranch refs/heads/fix/login\n\nworktree /repo/other\nHEAD ghi\nbranch refs/heads/other\n';
  installHappyDomGlobals(dom, { fetch: (async (_url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    requests.push(body);
    if (body.op === 'list') return Response.json({ ok: true, output: porcelain });
    if (body.op === 'branches') return Response.json({ ok: true, current: body.cwd === '/repo' ? 'main' : chat.gitBranch, local: ['main', 'fix/login', 'other', 'feature/search'] });
    return Response.json({ ok: true });
  }) as typeof fetch });
  setStorageModeForTests('localStorage');
  setLocalServerAvailableForTests(true);
  setWorkspaceFromServer({ path: '/repo', label: 'repo', isDefault: false });
  setSessionStateForTests({ chats: [chat], activeId: chat.id });
  document.body.innerHTML = '<div id="composerControls"></div>';
  const settle = async (condition: () => boolean) => {
    for (let i = 0; i < 80 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(condition(), 'UI settles');
  };
  const item = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('#composerRunTargetMenu button')].find(button => button.textContent?.includes(text));
  try {
    initComposerRunTarget();
    const button = document.getElementById('composerRunTargetBtn') as HTMLButtonElement;
    assert.equal(document.querySelectorAll('#composerRunTargetWrap button').length, 1);
    assert.equal(document.getElementById('composerBranchBtn'), null);
    assert.equal(button.textContent, 'login-fix');
    button.click();
    await settle(() => Boolean(item('Switch branch')));
    assert.equal(chat.worktreeRoot, '/repo/login-fix', 'clicking the active worktree opens options');
    item('Switch branch')!.click();
    await settle(() => Boolean(item('feature/search')));
    assert.equal(item('main'), undefined, 'workspace branch is locked in another checkout');
    assert.equal(item('other'), undefined, 'other worktree branch is excluded');
    item('feature/search')!.click();
    await settle(() => chat.gitBranch === 'feature/search' && !button.disabled);
    assert.ok(requests.some(body => body.op === 'checkout' && body.branch === 'feature/search' && body.cwd === '/repo/login-fix'));
    button.click();
    await settle(() => Boolean(item('Back to Local')));
    item('Back to Local')!.click();
    await settle(() => !chat.worktreeRoot && !button.disabled);
    assert.equal(button.textContent, '');
    assert.equal(button.getAttribute('aria-label'), 'Enable worktree');
    assert.equal(chat.gitBranch, 'main');
    assert.equal(requests.some(body => body.op === 'remove'), false, 'returning Local preserves the checkout');
  } finally {
    setLocalServerAvailableForTests(false);
    await teardownHappyDomAsync(dom);
  }
});

test('failed setup keeps retry and Back to Local accessible in the combined menu', async () => {
  const dom = new Window();
  const requests: any[] = [];
  installHappyDomGlobals(dom, { fetch: (async (_url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    requests.push(body);
    return Response.json({ ok: true, current: 'main' });
  }) as typeof fetch });
  setStorageModeForTests('localStorage');
  setLocalServerAvailableForTests(true);
  setWorkspaceFromServer({ path: '/repo', label: 'repo', isDefault: false });
  const chat = createEmptyChatObject('model', '/repo');
  chat.gitBranch = 'main';
  chat.worktreeSetupRequired = true;
  setSessionStateForTests({ chats: [chat], activeId: chat.id });
  document.body.innerHTML = '<div id="composerControls"></div>';
  try {
    initComposerRunTarget();
    const button = document.getElementById('composerRunTargetBtn') as HTMLButtonElement;
    button.click();
    for (let i = 0; i < 40 && !document.querySelector('#composerRunTargetMenu button'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const items = [...document.querySelectorAll<HTMLButtonElement>('#composerRunTargetMenu button')];
    assert.ok(items.some(item => item.textContent === 'Retry worktree setup'));
    assert.equal(requests.some(body => body.op === 'enable_chat'), false);
    items.find(item => item.textContent === 'Back to Local')!.click();
    for (let i = 0; i < 40 && button.disabled; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(chat.worktreeSetupRequired, undefined);
    assert.equal(button.getAttribute('aria-label'), 'Enable worktree');
  } finally {
    setLocalServerAvailableForTests(false);
    await teardownHappyDomAsync(dom);
  }
});
