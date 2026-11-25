import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions';
import type { SessionState } from '../../src/types';

test('Graphite panels open before the first message and restore each thread', async () => {
  const win = new Window({ url: 'http://localhost/#/app/code/chat' });
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    HTMLElement: win.HTMLElement,
    MutationObserver: win.MutationObserver,
  });
  document.body.innerHTML = `
    <main id="workspaceSplit">
      <header id="graphiteThreadHeader"></header>
      <section id="mainColumn"><div class="input-bar"><textarea id="msgInput"></textarea></div></section>
    </main>
    <section id="mobile"></section>`;
  const stage = document.getElementById('workspaceSplit')!;
  Object.defineProperty(stage, 'getClientRects', { value: () => [{}] });
  Object.defineProperty(stage, 'clientWidth', { value: 1440 });
  const first = createEmptyChatObject('fixture', '/workspace');
  const second = createEmptyChatObject('fixture', '/workspace');
  const sessions: SessionState = { version: 6, activeId: first.id, sidebarCollapsed: false, chats: [first, second] };
  setSessionStateForTests(sessions);
  const {
    dismissSurface, mountSurfacePanels, mountMobileSurfacePortal, moveActiveSurface,
    openSurface, registerSurface, refreshSurfacePanels,
  } = await import('../../src/ui/surfaces/surfaces-column');
  const { mountGraphiteThreadHeader } = await import('../../src/ui/thread-card');
  const { requestGraphiteSurface } = await import('../../src/ui/surfaces/surface-bridge');

  const preview = document.createElement('article');
  preview.dataset.resource = 'preview-instance';
  const terminal = document.createElement('article');
  terminal.dataset.resource = 'pty-instance';
  registerSurface('preview', { render: () => preview });
  registerSurface('terminal', { render: () => terminal });
  const diff = document.createElement('article');
  let diffTarget: unknown;
  let diffStats: { additions: number; deletions: number } | undefined;
  registerSurface('changes', {
    render: () => diff,
    availability: () => diffStats
      ? { available: true, diffStats }
      : { available: false, reason: 'No changes yet' },
    open: ({ target }) => { diffTarget = target; },
  });
  registerSurface('agents', {
    render: () => null,
    availability: () => ({ available: false, reason: 'No subagents yet' }),
  });
  const issues = document.createElement('article');
  registerSurface('issues', { render: () => issues });
  registerSurface('issue', {
    render: () => null,
    availability: () => ({ available: false, reason: 'No linked issue' }),
  });
  let fileBrowseChat: string | undefined;
  mountSurfacePanels(stage, { setFileBrowseChat: chat => { fileBrowseChat = chat?.id; } });
  mountGraphiteThreadHeader();
  const mainColumn = document.getElementById('mainColumn')!;
  assert.ok(mainColumn.classList.contains('graphite-new-thread'));
  const side = document.getElementById('surfaceSide')!;
  const bottom = document.getElementById('surfaceBottom')!;
  assert.equal(side.hidden, true);
  assert.equal(bottom.hidden, true);

  const sideToggle = document.getElementById('btnSurfaceSide')!;
  const bottomToggle = document.getElementById('btnSurfaceBottom')!;
  assert.equal(sideToggle.closest('[hidden]'), null);
  assert.equal(bottomToggle.closest('[hidden]'), null);
  bottomToggle.click();
  assert.equal(bottom.hidden, false);
  assert.equal(bottomToggle.getAttribute('aria-pressed'), 'true');
  bottomToggle.click();
  assert.equal(bottom.hidden, true);

  sideToggle.click();
  assert.equal(side.hidden, false);
  document.getElementById('msgInput')!.dispatchEvent(new win.KeyboardEvent('keydown', {
    key: 'j', ctrlKey: true, bubbles: true,
  }));
  assert.equal(side.hidden, true);
  sideToggle.click();
  assert.equal(side.hidden, false);
  assert.equal(side.querySelector('[role="menuitem"][aria-description="No subagents yet"]')?.getAttribute('aria-disabled'), 'true');
  assert.equal(openSurface('agents'), false);
  const threadDiff = side.querySelector<HTMLButtonElement>('[aria-label="Diff"]')!;
  assert.equal(threadDiff.getAttribute('aria-disabled'), 'true');
  threadDiff.click();
  assert.equal(diff.isConnected, false);
  side.querySelector<HTMLButtonElement>('[aria-label="Open workspace diff"]')!.click();
  assert.equal(side.contains(diff), true);
  assert.deepEqual(diffTarget, { kind: 'workspace' });
  assert.equal(fileBrowseChat, undefined);
  dismissSurface('changes');
  diffStats = { additions: 6375, deletions: 402 };
  refreshSurfacePanels();
  await Promise.resolve();
  const availableDiff = side.querySelector<HTMLButtonElement>('[aria-label="Diff"]')!;
  assert.equal(availableDiff.getAttribute('aria-description'), 'Inspect changes. 6375 added, 402 deleted.');
  assert.equal(availableDiff.querySelector('.graphite-surface-choice-hint'), null);
  assert.equal(availableDiff.querySelector('.graphite-surface-choice-title')?.textContent, 'Diff');
  const diffCopy = availableDiff.querySelector('.graphite-surface-choice-copy')!;
  assert.equal(diffCopy.children.length, 2, 'Diff keeps the same two-line copy structure as other cards');
  const diffCounts = diffCopy.querySelector<HTMLElement>(':scope > .graphite-surface-choice-stats')!;
  assert.equal(diffCounts.textContent, '+6375 −402');
  assert.equal(diffCounts.title, '6375 added, 402 deleted');
  assert.equal(diffCounts.getAttribute('aria-hidden'), 'true');
  assert.equal(availableDiff.querySelector('.graphite-surface-choice-added')?.textContent, '+6375');
  assert.equal(availableDiff.querySelector('.graphite-surface-choice-deleted')?.textContent, '−402');
  assert.equal(availableDiff.getAttribute('aria-keyshortcuts'), 'D');
  availableDiff.click();
  assert.equal(side.contains(diff), true);
  assert.equal(diffTarget, undefined, 'the main card still opens the thread diff');
  dismissSurface('changes');
  const linkedIssue = side.querySelector<HTMLButtonElement>('[aria-label="Issue"]')!;
  assert.equal(linkedIssue.getAttribute('aria-disabled'), 'true');
  linkedIssue.click();
  assert.equal(issues.isConnected, false);
  side.querySelector<HTMLButtonElement>('[aria-label="Open issues"]')!.click();
  assert.equal(side.contains(issues), true);
  assert.equal(side.querySelector('[role="tab"][aria-selected="true"]')?.textContent, 'Issues');
  dismissSurface('issues');
  document.getElementById('msgInput')!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'b', bubbles: true }));
  assert.equal(side.querySelector('[aria-selected="true"]'), null);
  side.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'b', bubbles: true }));
  assert.equal(side.querySelector('[data-resource="preview-instance"]'), preview);
  assert.equal(requestGraphiteSurface('terminal', 'show'), true);
  assert.equal(bottom.querySelector('[data-resource="pty-instance"]'), terminal);
  assert.equal(fileBrowseChat, first.id);

  moveActiveSurface('bottom');
  assert.equal(side.querySelector('[data-resource="pty-instance"]'), terminal);
  assert.equal(bottom.hidden, true);
  side.querySelector<HTMLElement>('[aria-label="Maximize"]')!.click();
  assert.equal(stage.dataset.surfaceMax, 'side');
  side.querySelector<HTMLElement>('[aria-label="Restore"]')!.click();
  assert.equal(stage.dataset.surfaceMax, '');
  const separator = side.querySelector<HTMLElement>('[role="separator"]')!;
  separator.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(separator.getAttribute('aria-valuenow'), '456');

  separator.setPointerCapture = () => {};
  const drag = (type: string, clientX: number) => separator.dispatchEvent(
    new win.PointerEvent(type, { bubbles: true, pointerId: 1, clientX }),
  );
  drag('pointerdown', 984);
  drag('pointermove', 360);
  await new Promise<void>(resolve => win.requestAnimationFrame(() => resolve()));
  assert.equal(stage.style.getPropertyValue('--mn-graphite-side-size'), '1080px');
  drag('pointerup', 360);
  assert.equal(stage.dataset.surfaceMax, '');
  assert.equal(separator.getAttribute('aria-valuemax'), '1080');

  drag('pointerdown', 360);
  drag('pointerup', 300);
  assert.equal(stage.dataset.surfaceMax, 'side');
  assert.equal(separator.hidden, true);
  assert.equal(side.querySelector('[data-resource="pty-instance"]'), terminal);
  side.querySelector<HTMLElement>('[aria-label="Restore"]')!.click();
  assert.equal(stage.dataset.surfaceMax, '');
  assert.equal(separator.getAttribute('aria-valuenow'), '1080');

  drag('pointerdown', 360);
  drag('pointermove', 500);
  await new Promise<void>(resolve => win.requestAnimationFrame(() => resolve()));
  assert.equal(separator.getAttribute('aria-valuenow'), '940');
  drag('pointercancel', 300);
  assert.equal(stage.dataset.surfaceMax, '');
  assert.equal(separator.getAttribute('aria-valuenow'), '1080');

  sessions.activeId = second.id;
  refreshSurfacePanels();
  await Promise.resolve();
  assert.equal(fileBrowseChat, undefined);
  assert.equal(side.hidden, true);
  assert.equal(bottom.hidden, true);
  sessions.activeId = first.id;
  refreshSurfacePanels();
  await Promise.resolve();
  assert.equal(fileBrowseChat, first.id);
  assert.equal(side.querySelector('[aria-selected="true"]')?.textContent, 'Terminal');
  assert.equal(side.querySelector('[data-resource="pty-instance"]'), terminal);

  first.history.push({ role: 'user', content: 'Build it' });
  win.dispatchEvent(new win.Event('hashchange'));
  await Promise.resolve();
  assert.equal(mainColumn.classList.contains('graphite-new-thread'), false);
  assert.equal(side.querySelector('[data-resource="pty-instance"]'), terminal);

  first.activeGoal = { factoryRunId: 'factory-run', skillId: 'factory', conditionText: 'Ship the app',
    startedAt: 1, tokenBaseline: 0, turnCount: 3, lastReason: 'Checking the build',
    factoryProgress: { phase: 'Verifying', completed: 2, total: 2 } };
  win.dispatchEvent(new win.Event('hashchange'));
  const factoryButton = [...document.querySelectorAll<HTMLButtonElement>('.graphite-thread-header__actions button')].find(b => b.textContent === 'Factory')!;
  assert.ok(factoryButton);
  Object.defineProperty(factoryButton, 'getClientRects', { value: () => [{}] });
  factoryButton.click();
  const factoryCard = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Factory"]')!;
  assert.match(factoryCard.textContent!, /Verifying/);
  assert.match(factoryCard.textContent!, /2 of 2 features passed/);
  assert.match(factoryCard.textContent!, /Pause factory/);
  first.activeGoal.paused = true;
  const { notifyManagedChatMetadata } = await import('../../src/chat/managed-chat-view');
  notifyManagedChatMetadata(first.id);
  assert.match(factoryCard.textContent!, /Resume factory/);
  factoryCard.querySelector<HTMLButtonElement>('[aria-label="Close factory details"]')!.click();
  delete first.activeGoal;
  win.dispatchEvent(new win.Event('hashchange'));

  // Canonical tool results arrive without the renderer-owned totals. The
  // thread's Diff entry must survive that, and change counts on navigation.
  first.chatCommandVersion = 1;
  first.codeChangeTotals = { additions: 0, deletions: 0 };
  first.history.push({ role: 'tool', tool_call_id: 'first-edit', content: '',
    codeChange: { path: 'shared.ts', additions: 4, deletions: 2 } });
  second.chatCommandVersion = 1;
  second.history = [{ role: 'user', content: 'Another edit' }, { role: 'tool', tool_call_id: 'second-edit', content: '',
    codeChange: { path: 'shared.ts', additions: 7, deletions: 1 } }];
  win.dispatchEvent(new win.Event('hashchange'));
  const headerDiff = document.querySelector<HTMLButtonElement>('.graphite-thread-header__diff')!;
  assert.equal(headerDiff.hidden, false);
  assert.match(headerDiff.textContent!, /\+4.*−2/);
  sessions.activeId = second.id;
  win.dispatchEvent(new win.Event('hashchange'));
  assert.equal(headerDiff.hidden, false);
  assert.match(headerDiff.textContent!, /\+7.*−1/);
  sessions.activeId = first.id;
  win.dispatchEvent(new win.Event('hashchange'));
  assert.match(headerDiff.textContent!, /\+4.*−2/);
  delete first.chatCommandVersion;
  delete second.chatCommandVersion;
  second.history = [];

  const mobileHost = document.getElementById('mobile')!;
  const unmount = mountMobileSurfacePortal(mobileHost, second.id);
  assert.equal(openSurface('preview'), true);
  assert.equal(mobileHost.querySelector('[data-resource="preview-instance"]'), preview);
  assert.equal(side.getAttribute('aria-modal'), 'true');
  unmount();
  await Promise.resolve();
  assert.equal(side.parentElement, stage);
  assert.equal(side.querySelector('[aria-selected="true"]')?.textContent, 'Terminal');
  assert.equal(side.getAttribute('aria-modal'), null);

  const { setWorkspaceFromServer, resetWorkspaceStateForTests } = await import('../../src/state/workspace');
  const { resetSidebarGitStateForTests } = await import('../../src/ui/sidebar-git-state');
  const { setIssuesStateForTests } = await import('../../src/state/issues-store');
  const { setLocalServerAvailableForTests, isLocalServerAvailable } = await import('../../src/tools/config');
  const fetchBefore = globalThis.fetch;
  const serverBefore = isLocalServerAvailable();
  try {
    setWorkspaceFromServer({ path: '/workspace', isDefault: false, label: 'Workspace' });
    setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
    setLocalServerAvailableForTests(true);
    const gitRequests: unknown[] = [];
    let cleanCheckout = false;
    globalThis.fetch = async (url, init) => {
      if (url !== '/api/git') return new Response(null, { status: 404 });
      gitRequests.push(JSON.parse(String(init?.body)));
      if (cleanCheckout) return Response.json({ ok: true });
      return Response.json({
        ok: true,
        staged: [{ path: 'index.ts', additions: 3, deletions: 1 }],
        unstaged: [{ path: 'index.ts', additions: 1, deletions: 2 }],
        untracked: [{ path: 'new.ts', additions: 2, deletions: 0 }, { path: 'image.png' }],
      });
    };
    diffStats = undefined;
    first.codeChangeTotals = { additions: 90, deletions: 80 };
    const branch = document.querySelector<HTMLButtonElement>('.graphite-thread-branch')!;
    Object.defineProperty(branch, 'getClientRects', { value: () => [{}] });
    assert.equal(branch.hidden, false);
    branch.click();
    const menu = document.querySelector('.graphite-thread-card-popover');
    assert.ok(menu);
    const changesLabel = '[aria-label="3 changed files, 6 additions, 3 deletions"]';
    for (let attempt = 0; attempt < 50 && !menu.querySelector(changesLabel); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const changes = menu.querySelector<HTMLButtonElement>(changesLabel)!;
    assert.equal(changes.querySelector('.graphite-thread-addition')?.textContent, '+6');
    assert.equal(changes.querySelector('.graphite-thread-deletion')?.textContent, '−3');
    const gitActions = '.graphite-thread-card__git-actions > button';
    const actionLabels = (card: Element) => Array.from(card.querySelectorAll(gitActions), button => button.textContent);
    assert.deepEqual(actionLabels(menu), ['Commit and push', 'Open PR']);
    assert.doesNotMatch(menu.textContent ?? '', /Permissions|Phone access|This computer/);
    assert.deepEqual(gitRequests, [{ op: 'status', cwd: '/workspace', lineStats: true }]);
    changes.click();
    assert.equal(menu.isConnected, false);
    assert.equal(side.contains(diff), true);
    assert.deepEqual(diffTarget, { kind: 'changes' });

    cleanCheckout = true;
    resetSidebarGitStateForTests({ cwd: '/workspace', current: 'feature/new-thread' });
    sessions.activeId = second.id;
    win.dispatchEvent(new win.Event('hashchange'));
    assert.ok(mainColumn.classList.contains('graphite-new-thread'));
    assert.equal(branch.hidden, false);
    assert.equal(branch.textContent, 'feature/new-thread');
    document.getElementById('msgInput')!.dispatchEvent(new win.KeyboardEvent('keydown', {
      key: '.', ctrlKey: !/mac/i.test(navigator.platform), metaKey: /mac/i.test(navigator.platform), bubbles: true,
    }));
    const cleanMenu = document.querySelector('.graphite-thread-card-popover');
    assert.ok(cleanMenu);
    for (let attempt = 0; attempt < 50 && !cleanMenu.textContent?.includes('No changed files'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.match(cleanMenu.textContent ?? '', /feature\/new-thread.*No changed files/);
    assert.deepEqual(actionLabels(cleanMenu), ['Open PR']);
    const servers = Array.from(cleanMenu.querySelectorAll('button')).find(control => control.textContent === 'Dev servers');
    assert.ok(servers);
    servers.click();
    const fullPage = Array.from(cleanMenu.querySelectorAll('button')).find(control => control.textContent === 'Open full page');
    assert.ok(fullPage, 'Dev servers exposes the full page even without configured servers');
    fullPage.click();
    assert.equal(cleanMenu.isConnected, false, 'Navigation dismisses the thread menu');
    assert.equal(win.location.hash, '#/app/code/dev-server');
  } finally {
    globalThis.fetch = fetchBefore;
    setLocalServerAvailableForTests(serverBefore);
    resetSidebarGitStateForTests();
    setIssuesStateForTests(null);
    resetWorkspaceStateForTests();
  }

  setSessionStateForTests(null);
  await win.close();
});
