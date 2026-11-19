import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';
import { beginChatTurnSetup, endChatTurnSetup } from '../../src/chat/chat-turn-guard.ts';
import { createEmptyChatObject, flushScheduledSessionSaveForTests, setSessionStateForTests } from '../../src/state/sessions.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { setWorkspaceFromServer } from '../../src/state/workspace.ts';
import { invalidateWorkspaceReposCache } from '../../src/state/workspace-repos.ts';
import { resetAppDialogForTests } from '../../src/ui/app-dialog.ts';
import { mountThreadCheckout } from '../../src/ui/thread-checkout.ts';

test('thread checkout switches a canonical chat Local and back through the server', async () => {
  const dom = new Window();
  const originalFetch = globalThis.fetch;
  const chat = createEmptyChatObject('model', '/repo');
  const preparation = { status: 'ready', intent: { id: 'saved' }, binding: { path: '/retained' } } as any;
  Object.assign(chat, { chatCommandVersion: 1, worktreeRoot: '/retained', gitBranch: 'feature', workspacePreparation: preparation });
  let saved = { ...chat };
  const actions: string[] = [];
  installHappyDomGlobals(dom, { fetch: (async (url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (String(url).endsWith('/workspace')) {
      actions.push(body.action);
      saved = { ...saved, worktreeRoot: body.action === 'local' ? '' : '/retained',
        gitBranch: body.action === 'local' ? '' : 'feature',
        workspacePreparation: { ...preparation, status: body.action === 'local' ? 'local' : 'ready' } };
      return Response.json({ chat: saved });
    }
    if (String(url).includes(`/api/chats/${chat.id}`)) return Response.json({ chat: saved });
    return Response.json({ ok: true, current: body.cwd === '/retained' ? 'feature' : 'main',
      local: ['main', 'feature'], savedChanges: [], worktrees: [
        { path: '/repo', branch: 'main', head: 'abc', detached: false },
        { path: '/retained', branch: 'feature', head: 'def', detached: false },
      ] });
  }) as typeof fetch });
  setStorageModeForTests('localStorage');
  setLocalServerAvailableForTests(true);
  setWorkspaceFromServer({ path: '/repo', label: 'repo', isDefault: false });
  setSessionStateForTests({ chats: [chat], activeId: chat.id });
  const controller = new AbortController();
  let current = true;
  const host = document.createElement('div');
  document.body.append(host);
  const click = (text: string) => {
    const button = [...host.querySelectorAll('button')].find(node => node.textContent?.includes(text));
    assert.ok(button, `Missing checkout button: ${text}`);
    button.click();
  };
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(), host.textContent || 'Checkout did not update');
  };
  try {
    await import('../../src/ui/git-panel.ts');
    await mountThreadCheckout({ host, chat, workspace: '/repo', signal: controller.signal,
      isCurrent: () => current, onChanged() { current = false; }, reposition() {} });
    click('Worktrees');
    click('main');
    await wait(() => !chat.worktreeRoot);
    // Reopen the thread picker after Local, as when navigating away and back.
    host.replaceChildren();
    current = true;
    await mountThreadCheckout({ host, chat, workspace: '/repo', signal: controller.signal,
      isCurrent: () => current, onChanged() { current = false; }, reposition() {} });
    click('Worktrees');
    click('feature');
    await wait(() => chat.worktreeRoot === '/retained');
    assert.deepEqual(actions, ['local', 'retry']);
    assert.equal(chat.gitBranch, 'feature');
    assert.doesNotMatch(host.textContent!, /server-managed checkout/);
  } finally {
    controller.abort();
    setSessionStateForTests(null);
    flushScheduledSessionSaveForTests();
    setLocalServerAvailableForTests(false);
    await teardownHappyDomAsync(dom);
    globalThis.fetch = originalFetch;
  }
});

test('thread checkout lists PRs and switches branches in the selected repository', async () => {
  const dom = new Window();
  const originalFetch = globalThis.fetch;
  const workspace = '/coltiva';
  const chat = createEmptyChatObject('model', workspace);
  const repos = ['backend', 'frontend'].map(id => ({
    id, relPath: id, absPath: `${workspace}/${id}`, isRoot: false, remote: null,
  }));
  const pulls: string[] = [];
  const switches: object[] = [];
  installHappyDomGlobals(dom, { fetch: (async (url, init) => {
    if (String(url).startsWith('/api/workspace/repos')) return Response.json({ repos });
    const body = JSON.parse(String(init?.body || '{}'));
    const name = body.cwd?.split('/').at(-1);
    if (body.op === 'branches') {
      assert.ok(repos.some(repo => repo.absPath === body.cwd));
      return Response.json({ ok: true, current: 'main', local: ['main'] });
    }
    if (body.op === 'prList') {
      pulls.push(body.cwd);
      return Response.json({ ok: true, prs: [{ number: 7, title: `${name} pull request`, headRef: 'feature', url: `https://github.com/test/${name}/pull/7` }] });
    }
    if (body.op === 'checkoutSwitch') {
      switches.push(body);
      return Response.json({ ok: true, branch: 'feature' });
    }
    return Response.json({ ok: true });
  }) as typeof fetch });
  setLocalServerAvailableForTests(true);
  setWorkspaceFromServer({ path: workspace, label: 'Coltiva', isDefault: false });
  invalidateWorkspaceReposCache();
  const host = document.createElement('div');
  document.body.append(host);
  const controller = new AbortController();
  const waitForButton = async (label: string) => {
    for (let i = 0; i < 100; i++) {
      const button = [...host.querySelectorAll('button')].find(node => node.textContent?.includes(label));
      if (button && !button.disabled) return button;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`Missing button ${label}`);
  };
  try {
    await mountThreadCheckout({ host, chat, workspace, signal: controller.signal,
      isCurrent: () => true, onChanged() {}, reposition() {} });
    (await waitForButton('Pull requests')).click();
    await waitForButton('backend pull request');
    const select = host.querySelector('select')!;
    assert.deepEqual([...select.options].map(row => row.value), ['backend', 'frontend']);
    select.value = 'frontend';
    select.dispatchEvent(new dom.Event('change') as unknown as Event);
    (await waitForButton('frontend pull request')).click();
    assert.deepEqual(pulls.slice(0, 2), ['/coltiva/backend', '/coltiva/frontend']);
    assert.deepEqual(switches, [{ op: 'checkoutSwitch', branch: 'feature',
      pullRequest: { number: 7, url: 'https://github.com/test/frontend/pull/7', headRef: 'feature' },
      cwd: '/coltiva/frontend', expectedBranch: 'main' }]);
    assert.equal(chat.workspacePath, workspace);
    assert.ok(!chat.worktreeRoot);
  } finally {
    controller.abort();
    invalidateWorkspaceReposCache();
    setLocalServerAvailableForTests(false);
    await teardownHappyDomAsync(dom);
    globalThis.fetch = originalFetch;
  }
});

for (const peerState of ['hidden empty', 'visible idle', 'running'] as const) {
  test(`thread branch switch with a ${peerState} peer in the same checkout`, async () => {
    const dom = new Window();
    const originalFetch = globalThis.fetch;
    const workspace = '/repo';
    const chat = createEmptyChatObject('model', workspace);
    const peer = createEmptyChatObject('model', workspace);
    const archived = createEmptyChatObject('model', workspace);
    archived.history.push({ role: 'user', content: 'Archived task' });
    archived.archivedAt = Date.now();
    if (peerState === 'visible idle') peer.history.push({ role: 'user', content: 'Earlier task' });
    const checkoutOps: string[] = [];
    installHappyDomGlobals(dom, { fetch: async (_url, init) => {
      const { op } = JSON.parse(String(init?.body || '{}'));
      if (op === 'checkoutPlan' || op === 'checkoutSwitch') checkoutOps.push(op);
      if (op === 'checkoutPlan') return Response.json({ ok: true, location: 'here' });
      if (op === 'checkoutSwitch') return Response.json({ ok: true, branch: 'feature' });
      return Response.json({ ok: true, current: 'main', local: ['main', 'feature'], savedChanges: [], worktrees: [] });
    } });
    setStorageModeForTests('localStorage');
    setLocalServerAvailableForTests(true);
    setWorkspaceFromServer({ path: workspace, label: 'repo', isDefault: false });
    setSessionStateForTests({ version: 6, sidebarCollapsed: false, chats: [chat, peer, archived], activeId: chat.id });
    const controller = new AbortController();
    const host = document.createElement('div');
    document.body.append(host);
    let switched = false;
    const dialog = () => document.querySelector('#appDialogPanel');
    const runningError = () => host.textContent?.includes('Another conversation is running in this checkout.');
    try {
      if (peerState === 'running') assert.ok(beginChatTurnSetup(peer.id));
      await mountThreadCheckout({ host, chat, workspace, signal: controller.signal,
        isCurrent: () => !switched, onChanged() { switched = true; }, reposition() {} });
      const feature = [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === 'feature');
      assert.ok(feature, 'Missing feature branch');
      feature.click();
      for (let i = 0; i < 100 && !switched && !dialog() && !runningError(); i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      if (peerState === 'visible idle') {
        assert.match(dialog()?.textContent ?? '', /1 other chat uses the workspace folder/);
        assert.deepEqual(checkoutOps, ['checkoutPlan']);
      } else if (peerState === 'running') {
        assert.ok(runningError(), host.textContent ?? '');
        assert.equal(dialog(), null);
        assert.deepEqual(checkoutOps, []);
      } else {
        assert.equal(dialog(), null, 'Hidden empty chats must not trigger a warning');
        assert.equal(switched, true);
        assert.deepEqual(checkoutOps, ['checkoutSwitch']);
      }
    } finally {
      controller.abort();
      resetAppDialogForTests();
      endChatTurnSetup(peer.id);
      setSessionStateForTests(null);
      flushScheduledSessionSaveForTests();
      setLocalServerAvailableForTests(false);
      await teardownHappyDomAsync(dom);
      globalThis.fetch = originalFetch;
    }
  });
}
