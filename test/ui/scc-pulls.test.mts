import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import serverDOMPurify from 'isomorphic-dompurify';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { setLocalServerAvailable } from '../../src/tools/config.ts';
import { createPullsView } from '../../src/ui/scc-pulls.ts';
import { buildPrDetail, prMergeLabel, renderPrMarkdown } from '../../src/ui/scc-pr-detail.ts';
import type { PullRequestDetail } from '../../src/state/forge-api.ts';
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
  view!.root.querySelector<HTMLButtonElement>('[data-state="merged"]')!.click();
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

test('drafts omit merge controls and conflicts disable direct merge', async () => {
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
  const merge = view!.root.querySelector<HTMLButtonElement>('.scc-prdetail__merge button')!;
  assert.equal(merge.disabled, true);
  assert.match(merge.title, /Resolve merge conflicts/);
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
  view!.root.querySelector<HTMLButtonElement>('[data-state="merged"]')!.click();
  await settle();
  releaseOld!({ ok: true, prs: [pr(2)] });
  await old;
  assert.equal(view!.root.querySelector('.scc-prrow')?.getAttribute('data-number'), '3');
  assert.equal(view!.root.querySelector('[data-state="merged"]')?.getAttribute('aria-pressed'), 'true');
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
