import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import serverDOMPurify from 'isomorphic-dompurify';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { setLocalServerAvailable } from '../../src/tools/config.ts';
import { createPullsView, suggestPrTitle } from '../../src/ui/scc-pulls.ts';
import { createChecksView } from '../../src/ui/scc-checks.ts';
import { buildPrDetail, prMergeLabel, renderPrMarkdown } from '../../src/ui/scc-pr-detail.ts';
import { launchInstance, resetInstancesForTests } from '../../src/os/instances.ts';
import { setWorkspaceFromServer, resetWorkspaceStateForTests } from '../../src/state/workspace.ts';
import { invalidateWorkspaceReposCache } from '../../src/state/workspace-repos.ts';
import type { ForgeStatus, PullRequestDetail } from '../../src/state/forge-api.ts';
import type { SccContext, SccView } from '../../src/ui/scc-shared.ts';

const originalFetch = globalThis.fetch;
const originalSanitize = DOMPurify.sanitize;
let win: Window;
let view: SccView | undefined;

afterEach(async () => {
  view?.destroy();
  view = undefined;
  globalThis.fetch = originalFetch;
  DOMPurify.sanitize = originalSanitize;
  await win?.happyDOM.close();
});

function setup(): void {
  win = new Window();
  installHappyDomGlobals(win);
  Object.assign(globalThis, { HTMLInputElement: win.HTMLInputElement, HTMLTextAreaElement: win.HTMLTextAreaElement, HTMLSelectElement: win.HTMLSelectElement });
  setLocalServerAvailable(true);
}

function pr(number: number, extra: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    number, title: `Improve PR ${number}`, state: 'open', draft: false, author: 'minnow-dev',
    headRef: `feature/${number}`, baseRef: 'main', createdAt: '', updatedAt: '', additions: 12,
    deletions: 4, changedFiles: 1, url: `https://github.com/minnow/app/pull/${number}`,
    reviewDecision: '', mergeable: 'mergeable', labels: [], checks: 'success', checkCount: 1,
    body: '## Summary\n\nReadable **Markdown**.', mergeStateStatus: 'clean', crossRepository: false,
    files: [{ path: 'src/app.ts', additions: 12, deletions: 4 }],
    commits: [{ sha: '123abcd', subject: 'Improve the app', author: 'minnow-dev' }],
    reviews: [], statusChecks: [{ name: 'CI', status: 'completed', conclusion: 'success', url: 'https://github.com/minnow/app/actions/runs/1' }],
    ...extra,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 1));
}

test('pull requests and Actions name the missing remote and omit GitHub CLI installation instructions', async () => {
  setup();
  const ctx: SccContext = { getCwd: () => '/repo', getBranch: () => 'main', refreshAll: async () => {}, refreshSection: async () => {}, goTo() {}, setBadge() {} };
  const status: ForgeStatus = {
    ok: true, host: 'none', hostname: '', remoteUrl: '', repo: '', supported: false,
    cliInstalled: false, cliVersion: '', authenticated: false, reason: 'This repository has no remote.',
  };
  for (const [create, feature] of [[createPullsView, 'pull requests'], [createChecksView, 'Actions']] as const) {
    view = create(ctx, { getForgeStatus: () => status });
    document.body.append(view.root);
    await settle();
    assert.match(view.root.querySelector('.scc-empty--unavailable')?.textContent ?? '', /No remote configured/);
    assert.match(view.root.querySelector('.scc-empty__body')?.textContent ?? '', new RegExp(`Add a GitHub remote to use ${feature}`));
    assert.doesNotMatch(view.root.textContent ?? '', /winget install|GitHub CLI not found/);
    view.destroy();
    view = undefined;
  }
});

function mount(prs: PullRequestDetail[], handler?: (args: Record<string, any>) => Promise<object>): void {
  globalThis.fetch = (async (_url, init) => {
    const args = JSON.parse(String(init?.body));
    const data = handler ? await handler(args) : args.op === 'prList'
      ? { ok: true, prs: prs.filter((item) => args.state === 'all' || item.state === args.state) }
      : args.op === 'prView' ? { ok: true, pr: prs.find((item) => item.number === args.number) }
        : { ok: true, local: ['main', 'feature/2'], remote: [] };
    return new Response(JSON.stringify(data));
  }) as typeof fetch;
  const ctx: SccContext = { getCwd: () => '/repo', getBranch: () => 'feature/2', refreshAll: async () => view?.refresh(), refreshSection: async () => view?.refresh(), goTo() {}, setBadge() {} };
  view = createPullsView(ctx, { getForgeStatus: () => null });
  document.body.appendChild(view.root);
}

test('current branch opens automatically; search matches labels and state filters fetch the right list', async () => {
  setup();
  mount([pr(1), pr(2, { labels: [{ name: 'Accessibility', color: '' }] }), pr(3, { state: 'merged' })]);
  await settle();
  assert.equal(view!.root.querySelector('.scc-prdetail__number')?.textContent, '#2');
  assert.equal(view!.root.querySelector('.scc-prrow[data-number="2"]')?.getAttribute('aria-pressed'), 'true');
  const search = view!.root.querySelector<HTMLInputElement>('input[type="search"]')!;
  search.value = 'ACCESSIBILITY';
  search.dispatchEvent(new win.Event('input') as unknown as Event);
  assert.equal(view!.root.querySelectorAll('.scc-prrow').length, 1);
  search.value = '';
  search.dispatchEvent(new win.Event('input') as unknown as Event);
  view!.root.querySelector<HTMLButtonElement>('[data-value="merged"]')!.click();
  await settle();
  assert.equal(view!.root.querySelector('.scc-prdetail__number')?.textContent, '#3');
  assert.equal(view!.root.querySelectorAll('.scc-prrow').length, 1);
});

test('tabs expose keyboard semantics and stay selected through refresh', async () => {
  setup();
  const current = pr(2);
  mount([current]);
  await settle();
  const files = view!.root.querySelector<HTMLButtonElement>('[role="tab"][data-tab="files"]')!;
  files.click();
  assert.equal(files.getAttribute('aria-selected'), 'true');
  assert.equal(view!.root.querySelector<HTMLElement>('[role="tabpanel"][data-tab="overview"]')!.hidden, true);
  current.title = 'Updated title';
  await view!.refresh();
  assert.equal(view!.root.querySelector('[role="tab"][data-tab="files"]')!.getAttribute('aria-selected'), 'true');
  view!.root.querySelector('[role="tab"][data-tab="files"]')!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }) as unknown as KeyboardEvent);
  assert.equal(document.activeElement?.getAttribute('data-tab'), 'commits');
  assert.equal(view!.root.querySelector('[role="tab"][data-tab="commits"]')!.getAttribute('aria-selected'), 'true');
});

test('refresh preserves new PR form and typed content', async () => {
  setup();
  mount([pr(2)]);
  await settle();
  view!.root.querySelector<HTMLButtonElement>('[title="New pull request"]')!.click();
  await settle();
  const title = view!.root.querySelector<HTMLInputElement>('[aria-label="Pull request title"]')!;
  title.value = 'My unfinished pull request';
  await view!.refresh();
  assert.equal(view!.root.querySelector('[aria-label="Pull request title"]'), title);
  assert.equal(title.value, 'My unfinished pull request');
});

test('drafts omit merge controls and conflicts offer recovery instead of direct merge', async () => {
  setup();
  const current = pr(2, { draft: true });
  mount([current]);
  await settle();
  assert.equal(view!.root.querySelector('[aria-label="Merge method"]'), null);
  assert.match(view!.root.querySelector('.scc-prdetail__merge')!.textContent!, /Mark ready for review/);
  assert.ok([...view!.root.querySelectorAll('button')].some((item) => item.textContent === 'Ready for review'));
  current.draft = false;
  current.mergeable = 'conflicting';
  await view!.refresh();
  const resolve = view!.root.querySelector<HTMLButtonElement>('.scc-prdetail__merge button')!;
  assert.equal(resolve.disabled, false);
  assert.equal(resolve.textContent, 'Resolve conflicts');
  assert.equal(view!.root.querySelector('[aria-label="Merge method"]'), null);
  resolve.click();
  assert.match(document.querySelector('.git-recovery-popover')!.textContent!, /Pull request has merge conflicts/);
  assert.doesNotMatch(document.querySelector('.git-recovery-popover__summary')!.textContent!, /paused/);
});

test('an older filter response cannot restore a previous state list', async () => {
  setup();
  let releaseOld: (value: object) => void;
  let holdOpen = false;
  mount([pr(2)], async (args) => {
    if (args.op === 'prView') return { ok: true, pr: pr(args.number) };
    if (args.state === 'open' && holdOpen) return new Promise((resolve) => { releaseOld = resolve; });
    return { ok: true, prs: args.state === 'merged' ? [pr(3, { state: 'merged' })] : [pr(2)] };
  });
  await settle();
  holdOpen = true;
  const old = view!.refresh();
  await settle();
  view!.root.querySelector<HTMLButtonElement>('[data-value="merged"]')!.click();
  await settle();
  releaseOld!({ ok: true, prs: [pr(2)] });
  await old;
  assert.equal(view!.root.querySelector('.scc-prrow')?.getAttribute('data-number'), '3');
  assert.equal(view!.root.querySelector('[data-value="merged"]')?.getAttribute('aria-pressed'), 'true');
});

test('out-of-order responses for the same PR cannot replace newer details', async () => {
  setup();
  let calls = 0;
  let releaseOld: (value: object) => void;
  mount([pr(2)], async (args) => {
    if (args.op === 'prList') return { ok: true, prs: [pr(2)] };
    calls++;
    if (calls === 2) return new Promise((resolve) => { releaseOld = resolve; });
    return { ok: true, pr: pr(2, { title: calls === 1 ? 'Original' : 'Newest' }) };
  });
  await settle();
  const old = view!.refresh();
  await settle();
  await view!.refresh();
  releaseOld!({ ok: true, pr: pr(2, { title: 'Stale' }) });
  await old;
  assert.equal(view!.root.querySelector('.scc-prdetail__title')!.textContent, 'Newest');
});

test('Markdown renders prose and task lists while removing active content and unsafe URLs', () => {
  setup();
  DOMPurify.sanitize = serverDOMPurify.sanitize;
  const host = document.createElement('div');
  renderPrMarkdown(host, '## Summary\n\n**Fixed**\n\n- [x] Tested\n\n[Issue](../issues/7)\n\n<script>alert(1)</script><a href="javascript:alert(1)">Bad</a><img src="data:image/svg+xml,bad" onerror="alert(1)"><input type="text"><p style="position:fixed" id="app">Body</p>', pr(2).url);
  assert.equal(host.querySelector('h2')?.textContent, 'Summary');
  assert.equal(host.querySelector('strong')?.textContent, 'Fixed');
  assert.equal(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled, true);
  assert.equal(host.querySelector('script, [onerror], [style], [id], input[type="text"], img'), null);
  const link = host.querySelector('a[href]')!;
  assert.equal(link.getAttribute('href'), 'https://github.com/minnow/app/issues/7');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(host.querySelector('a[href^="javascript:"]'), null);
});

test('empty check conclusions stay pending; draft and conflict merge states are explicit', () => {
  setup();
  const root = buildPrDetail(pr(2, { checks: 'pending', statusChecks: [{ name: 'External check', status: '', conclusion: '', url: '' }] }), {
    actions: document.createElement('div'), mergeActions: document.createElement('div'), reviewHost: document.createElement('div'), activeTab: 'checks', onTab() {},
  });
  assert.equal(root.querySelector('.scc-checkrow__state')?.textContent, 'Running');
  assert.equal(root.querySelector('.scc-checkrow .scc-dot--failure'), null);
  assert.equal(prMergeLabel(pr(2, { draft: true })), 'Draft pull request');
  assert.equal(prMergeLabel(pr(2, { mergeable: 'conflicting' })), 'Merge conflicts');
});

test('PR rows say where each PR is checked out without asking GitHub per row', async () => {
  setup();
  const ops: string[] = [];
  const porcelain = 'worktree /repo\nHEAD abc\nbranch refs/heads/feature/2\n\nworktree /repo/.worktrees/review\nHEAD def\nbranch refs/heads/feature/1\n';
  const prs = [pr(1), pr(2), pr(3, { headRef: 'feature/1', crossRepository: true })];
  mount(prs, async (args) => {
    ops.push(args.op);
    if (args.op === 'list') return { ok: true, output: porcelain };
    if (args.op === 'prList') return { ok: true, prs };
    if (args.op === 'prView') return { ok: true, pr: prs.find((item) => item.number === args.number) };
    if (args.op === 'checkoutPlan') return { ok: true, location: 'current', branch: 'feature/2' };
    return { ok: true, local: ['main', 'feature/2'], remote: [] };
  });
  await settle();
  const row = (n: number) => view!.root.querySelector(`.scc-prrow[data-number="${n}"]`)?.textContent ?? '';
  assert.match(row(2), /Checked out here/);
  assert.match(row(1), /In review/);
  assert.doesNotMatch(row(3), /In review|Checked out here/, 'a fork head name never matches a local worktree');
  assert.match(row(3), /Fork/);
  assert.equal(ops.filter((op) => op === 'checkoutPlan').length, 1, 'only the opened detail asks the server');
});

test('new pull request titles follow GitHub: one commit uses its subject, several use the branch name', () => {
  assert.equal(suggestPrTitle('feat/thing', { ahead: 1, subject: 'fix(ui): one commit' }), 'fix(ui): one commit');
  assert.equal(suggestPrTitle('minnow/min-7-customizable-keyboard-shortcuts-68e0536535', { ahead: 3, subject: 'x' }), 'Min 7 customizable keyboard shortcuts');
  assert.equal(suggestPrTitle('worktree-multi-repo-workspaces', { ahead: 13, subject: 'x' }), 'Worktree multi repo workspaces');
});

test('Source Control switches sibling repo views, restores PR drafts, and labels linked worktrees', async () => {
  setup();
  const { openSourceControlCenter, mountSourceControlCenter, resetSourceControlCenterForTests } =
    await import('../../src/ui/source-control-center.ts');
  const workspace = '/coltiva';
  const worktree = '/worktrees/backend-review';
  const repos = ['backend', 'frontend'].map(id => ({
    id, relPath: id, absPath: `${workspace}/${id}`, isRoot: false, remote: null,
  }));
  const listCalls: string[] = [];
  globalThis.fetch = (async (url, init) => {
    if (String(url).startsWith('/api/workspace/repos')) return Response.json({ repos });
    const args = JSON.parse(String(init?.body || '{}'));
    const name = args.cwd === worktree ? 'backend' : args.cwd?.split('/').at(-1);
    const entry = pr(7, { title: `${name} pull request`, url: `https://github.com/test/${name}/pull/7` });
    if (args.op === 'prList') { listCalls.push(args.cwd); return Response.json({ ok: true, prs: [entry] }); }
    if (args.op === 'prView') return Response.json({ ok: true, pr: entry });
    if (args.op === 'checkoutPlan' && args.cwd === `${workspace}/backend`) {
      return Response.json({ ok: true, location: 'worktree', worktreePath: worktree });
    }
    if (args.op === 'forgeStatus' || args.op === 'forgeRefresh') {
      return Response.json({ ok: true, supported: true, host: 'github', repo: `test/${name}` });
    }
    return Response.json({ ok: true, current: 'feature/7', local: ['main', 'feature/7'] });
  }) as typeof fetch;
  setWorkspaceFromServer({ path: workspace, label: 'Coltiva', isDefault: false });
  const area = document.createElement('main');
  area.id = 'sourceControlView';
  document.body.append(area);
  launchInstance('source-control');
  const { getGitPanelCwd, resetGitPanelForTests } = await import('../../src/ui/git-panel.ts');
  function pickRepo(id: string) {
    area.querySelector<HTMLButtonElement>('.scc-head__repo-switch')!.click();
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')]
      .find(row => row.textContent?.includes(id));
    assert.ok(option);
    option.click();
  }
  try {
    await mountSourceControlCenter();
    await openSourceControlCenter({ section: 'pulls' });
    assert.match(area.querySelector('.scc-prrow')?.textContent ?? '', /backend pull request/);
    const panelBefore = getGitPanelCwd();
    const oldView = area.querySelector('.scc-pulls');
    area.querySelector<HTMLButtonElement>('button[title="New pull request"]')!.click();
    await settle();
    const draft = area.querySelector<HTMLTextAreaElement>('textarea[aria-label="Pull request description"]')!;
    draft.value = 'Backend rollout';
    draft.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
    pickRepo('frontend');
    assert.ok(!oldView?.isConnected);
    await settle();
    assert.match(area.querySelector('.scc-prrow')?.textContent ?? '', /frontend pull request/);
    assert.equal(area.querySelector('textarea[aria-label="Pull request description"]'), null);
    pickRepo('backend');
    await settle();
    assert.equal(area.querySelector<HTMLTextAreaElement>('textarea[aria-label="Pull request description"]')?.value, 'Backend rollout');
    assert.deepEqual([...new Set(listCalls)], repos.map(repo => repo.absPath));

    [...area.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!.click();
    await settle();
    area.querySelector<HTMLButtonElement>('.scc-prrow')!.click();
    await settle();
    [...area.querySelectorAll('button')].find(button => button.textContent === 'Open worktree')!.click();
    await settle();
    assert.equal(area.querySelector('.scc-head__repo-switch .scc-btn__label')?.textContent, 'backend');
    assert.equal((area.querySelector('.scc-head__worktree') as HTMLButtonElement).title, `Browsing ${worktree}`);
    assert.equal(getGitPanelCwd(), panelBefore);
  } finally {
    resetSourceControlCenterForTests();
    resetGitPanelForTests();
    resetInstancesForTests();
    resetWorkspaceStateForTests();
    invalidateWorkspaceReposCache();
  }
});

test('Source Control offers a repository discovery retry when the workspace scan fails', async () => {
  setup();
  const { mountSourceControlCenter, resetSourceControlCenterForTests } = await import('../../src/ui/source-control-center.ts');
  const workspace = '/discovery-retry';
  const requests: string[] = [];
  globalThis.fetch = (async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/workspace/repos')) {
      requests.push(path);
      if (!path.includes('refresh=1')) return new Response(null, { status: 503 });
      return Response.json({ repos: [{ id: 'api', relPath: 'api', absPath: `${workspace}/api`, isRoot: false, remote: null }] });
    }
    const args = JSON.parse(String(init?.body || '{}'));
    return Response.json(args.op === 'status' && args.cwd !== `${workspace}/api`
      ? { ok: false, error: 'not a git repository' }
      : { ok: true, current: 'main', local: ['main'] });
  }) as typeof fetch;
  setWorkspaceFromServer({ path: workspace, label: 'Retry', isDefault: false });
  const area = document.createElement('main');
  area.id = 'sourceControlView';
  document.body.append(area);
  launchInstance('source-control');
  try {
    await mountSourceControlCenter();
    const missing = area.querySelector('.scc-no-repo')!;
    assert.match(missing.textContent ?? '', /Could not discover repositories/);
    (missing.querySelector('button') as HTMLButtonElement).click();
    await settle();
    assert.ok(requests.some(path => path.includes('refresh=1')));
    assert.equal((missing as HTMLElement).hidden, true);
    assert.equal(area.querySelector('.scc-head__repo-label')?.textContent, 'api');
  } finally {
    resetSourceControlCenterForTests();
    resetInstancesForTests();
    resetWorkspaceStateForTests();
    invalidateWorkspaceReposCache();
  }
});

test('one sync menu runs bulk actions and remembers the main-button scope per workspace', async () => {
  setup();
  const { mountSourceControlCenter, openSourceControlCenter, resetSourceControlCenterForTests } = await import('../../src/ui/source-control-center.ts');
  const { resetAppDialogForTests } = await import('../../src/ui/app-dialog.ts');
  const workspace = '/sync-project';
  const linked = '/trees/backend-review';
  const backend = `${workspace}/backend`;
  const frontend = `${workspace}/frontend`;
  const solo = '/sync-solo';
  const preference = `minnow.scc.sync-all:${workspace}`;
  globalThis.localStorage?.removeItem(preference);
  const repo = (id: string, absPath: string) => ({ id, relPath: id, absPath, isRoot: id === '.', remote: null });
  const syncCalls: string[][] = [];
  globalThis.fetch = (async (url, init) => {
    const request = new URL(String(url), 'http://localhost');
    if (request.pathname === '/api/workspace/repos') {
      const checkout = request.searchParams.get('checkout');
      const repos = checkout === linked ? [repo('.', linked)]
        : checkout === solo ? [repo('.', solo)]
        : [repo('backend', backend), repo('frontend', frontend)];
      return Response.json({ repos });
    }
    const args = JSON.parse(String(init?.body || '{}'));
    if (args.op === 'list') return Response.json({ ok: true, output: `worktree ${backend}\nHEAD 0000\nbranch refs/heads/main\n` });
    if (['fetch', 'pull', 'push'].includes(args.op)) {
      syncCalls.push([args.op, args.cwd]);
      if (args.op === 'pull' && args.cwd === linked) return Response.json({ ok: false, error: 'Local edits need attention' });
    }
    if (args.op === 'branchTree') return Response.json({ ok: true, current: 'main', branches: [{ name: 'main', upstream: 'origin/main' }] });
    if (args.op === 'status') return Response.json({ ok: true, branch: 'main', ahead: 3, behind: 2 });
    return Response.json({ ok: true, branch: 'main', current: 'main', local: ['main'] });
  }) as typeof fetch;
  setWorkspaceFromServer({ path: workspace, label: 'Sync project', isDefault: false });
  const area = document.createElement('main');
  area.id = 'sourceControlView';
  document.body.append(area);
  launchInstance('source-control');
  const openOptions = () => area.querySelector<HTMLButtonElement>('button[aria-label="Sync options"]')!.click();
  const menuItem = (name: string, role = 'menuitem') => {
    const item = [...document.querySelectorAll<HTMLButtonElement>(`[role="${role}"]`)]
      .find(row => row.textContent === name);
    assert.ok(item);
    return item;
  };
  try {
    await mountSourceControlCenter();
    await openSourceControlCenter({ cwd: linked });
    assert.ok(area.querySelector('.scc-head__sync[data-multi-repo]'));
    assert.equal(area.querySelectorAll('.scc-head__sync-menu').length, 1);
    area.querySelector<HTMLButtonElement>('.scc-head__fetch')!.click();
    await settle();
    assert.deepEqual(syncCalls.splice(0), [['fetch', linked]]);
    for (const verb of ['Fetch', 'Push', 'Pull']) {
      openOptions();
      menuItem(`${verb} all`).click();
      await settle();
      assert.deepEqual(syncCalls.splice(0), [[verb.toLowerCase(), linked], [verb.toLowerCase(), frontend]]);
    }
    const summary = document.querySelector('#appDialogPanel');
    assert.match(summary?.textContent ?? '', /Pulled 1 of 2 repositories/);
    assert.match(summary?.textContent ?? '', /backend\s+Local edits need attention/);
    resetAppDialogForTests();

    const toggleLabel = 'Main buttons sync all repos';
    openOptions();
    const toggle = menuItem(toggleLabel, 'menuitemcheckbox');
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    toggle.click();
    assert.equal(area.querySelector('.scc-head__fetch')?.getAttribute('aria-label'), 'Fetch all repositories');
    assert.equal(area.querySelector('.scc-head__pull .scc-head__sync-count')?.hasAttribute('hidden'), true);
    area.querySelector<HTMLButtonElement>('.scc-head__fetch')!.click();
    await settle();
    assert.deepEqual(syncCalls.splice(0), [['fetch', linked], ['fetch', frontend]]);

    setWorkspaceFromServer({ path: solo, label: 'Solo', isDefault: false });
    await mountSourceControlCenter();
    assert.equal(area.querySelector('.scc-head__sync[data-multi-repo]'), null);
    assert.equal(area.querySelector('.scc-head__fetch')?.getAttribute('aria-label'), 'Fetch');

    setWorkspaceFromServer({ path: workspace, label: 'Sync project', isDefault: false });
    await mountSourceControlCenter();
    openOptions();
    const remembered = menuItem(toggleLabel, 'menuitemcheckbox');
    assert.equal(remembered.getAttribute('aria-checked'), 'true');
    remembered.click();
    assert.equal(area.querySelector('.scc-head__fetch')?.getAttribute('aria-label'), 'Fetch');
  } finally {
    globalThis.localStorage?.removeItem(preference);
    resetAppDialogForTests();
    resetSourceControlCenterForTests();
    resetInstancesForTests();
    resetWorkspaceStateForTests();
    invalidateWorkspaceReposCache();
  }
});
