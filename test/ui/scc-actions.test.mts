import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import serverDOMPurify from 'isomorphic-dompurify';
import { setLocalServerAvailable } from '../../src/tools/config.ts';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { createActionsView } from '../../src/ui/scc-actions.ts';
import { createReleasesView } from '../../src/ui/scc-releases.ts';
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
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
function setup(reply: (body: any) => any) {
  win = new Window();
  installHappyDomGlobals(win);
  setLocalServerAvailable(true);
  Object.assign(globalThis, {
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    HTMLSelectElement: win.HTMLSelectElement,
  });
  globalThis.fetch = async (_url, init) =>
    new Response(JSON.stringify(await reply(JSON.parse(String(init?.body)))));
  let cwd = '/repo';
  const ctx: SccContext = {
    getCwd: () => cwd,
    getBranch: () => 'main',
    refreshAll: async () => {},
    refreshSection: async () => {},
    goTo: () => {},
    setBadge: () => {},
  };
  return {
    ctx,
    switchRoot: () => {
      cwd = '/other';
    },
  };
}
function click(label: string) {
  const node = [...view!.root.querySelectorAll('button')].find((n) => n.textContent === label || n.getAttribute('aria-label') === label || n.querySelector('.scc-action-row__title')?.textContent === label);
  assert(node, label);
  node.click();
}
test('command editor survives polling and local launch uses selected worktree', async () => {
  const calls: any[] = [];
  const { ctx } = setup((body) => {
    calls.push(body);
    if (body.op === 'commandList')
      return {
        ok: true,
        commands: [
          { id: 'build', label: 'Build', command: 'npm run build', cwd: '.', env: {}, secrets: {} },
        ],
      };
    return { ok: true, workflows: [], runs: [] };
  });
  view = createActionsView(ctx, { getForgeStatus: () => null });
  win.document.body.append(view.root);
  await flush();
  click('Commands');
  await flush();
  click('Build');
  const label = view.root.querySelector<HTMLInputElement>('input[aria-label="Label"]')!;
  label.value = 'Unfinished draft';
  await view.refresh();
  assert.equal(view.root.querySelector('input[aria-label="Label"]'), label);
  assert.equal(label.value, 'Unfinished draft');
  click('Run saved command');
  await flush();
  assert(
    calls.some(
      (call) => call.op === 'localRunStart' && call.cwd === '/repo' && call.commandId === 'build',
    ),
  );
});
test('workspace change clears command editor', async () => {
  const { ctx, switchRoot } = setup(() => ({ ok: true, workflows: [], commands: [] }));
  view = createActionsView(ctx, { getForgeStatus: () => null });
  await flush();
  click('Commands');
  await flush();
  click('New command');
  assert(view.root.querySelector('textarea'));
  switchRoot();
  await view.refresh();
  assert.equal(view.root.querySelector('textarea'), null);
});
test('release edits survive refresh and immutable releases have no mutation controls', async () => {
  let immutable = false;
  const release = {
    id: 1,
    tag: 'v1',
    title: 'Release 1',
    body: 'Notes',
    target: 'main',
    draft: true,
    prerelease: false,
    url: 'https://github.com/o/r/releases/tag/v1',
    assets: [],
    createdAt: '',
  };
  const { ctx } = setup((body) =>
    body.op === 'releaseList'
      ? { ok: true, releases: [release] }
      : { ok: true, release: { ...release, immutable }, canWrite: true },
  );
  view = createReleasesView(ctx);
  await flush();
  click('Release 1 · v1 · Draft');
  await flush();
  click('Edit release');
  const notes = view.root.querySelector<HTMLTextAreaElement>('textarea')!;
  notes.value = 'Unsaved notes';
  await view.refresh();
  assert.equal(notes.value, 'Unsaved notes');
  immutable = true;
  click('Release 1 · v1 · Draft');
  await flush();
  assert(!view.root.textContent?.includes('Publish release'));
  assert(view.root.textContent?.includes('immutable'));
});

test('release overview auto-selects, sanitizes notes, filters stable releases, and retries failures', async () => {
  DOMPurify.sanitize = serverDOMPurify.sanitize;
  let fail = true;
  const stable = { id: 1, tag: 'v1', title: 'Stable', body: '## Changes\nNotes <script>alert(1)</script>', target: 'main', draft: false, prerelease: false, immutable: false, url: '', assets: [], createdAt: '' };
  const beta = { ...stable, id: 2, title: 'Beta', prerelease: true };
  const { ctx } = setup(body => body.op === 'releaseList' ? { ok: true, releases: [stable, beta] } : fail ? { ok: false, error: 'HTTP 404' } : { ok: true, release: stable, canWrite: true });
  view = createReleasesView(ctx);
  await flush();
  assert(view.root.textContent?.includes('Could not open this release'));
  fail = false;
  click('Retry');
  await flush();
  const overview = view.root.querySelector('.scc-release__notes')!;
  assert.equal(overview.querySelector('h2')?.textContent, 'Changes');
  assert.equal(overview.querySelector('script'), null);
  assert.equal(view.root.querySelector<HTMLElement>('.scc-release__editor')?.hidden, true);
  const filter = view.root.querySelector<HTMLSelectElement>('select[aria-label="Release status"]')!;
  filter.value = 'published';
  filter.dispatchEvent(new win.Event('change'));
  assert.equal(view.root.querySelectorAll('.scc-action-row').length, 1);
  assert.equal(view.root.querySelector('.scc-action-row__title')?.textContent, 'Stable');
});

test('run polling preserves expanded jobs and loaded logs', async () => {
  let revision = 0;
  const run = { id: 42, workflow: 'CI', title: 'Build commit', branch: 'main', sha: 'abc123', event: 'push', status: 'completed', conclusion: 'failure', createdAt: '', updatedAt: '', url: '' };
  const jobs = [
    { id: 1, name: 'Tests', status: 'completed', conclusion: 'success', startedAt: '', completedAt: '', steps: [] },
    { id: 2, name: 'Build', status: 'completed', conclusion: 'failure', startedAt: '', completedAt: '', steps: [] },
  ];
  const { ctx } = setup(body => {
    if (body.op === 'runList') return { ok: true, runs: [run] };
    if (body.op === 'runView') return { ok: true, run: { ...run, updatedAt: String(revision), jobs } };
    if (body.op === 'runLog') return { ok: true, log: 'Saved job output' };
    return { ok: true };
  });
  view = createActionsView(ctx, { getForgeStatus: () => null });
  await flush();
  const sections = view.root.querySelectorAll<HTMLElement>('.scc-job');
  assert.equal(sections[0]!.querySelector<HTMLElement>('.scc-job__body')!.hidden, true);
  assert.equal(sections[1]!.querySelector<HTMLElement>('.scc-job__body')!.hidden, true);
  sections[0]!.querySelector<HTMLButtonElement>('.scc-job__head')!.click();
  sections[0]!.querySelector<HTMLButtonElement>('.scc-job__body button')!.click();
  await flush();
  const log = view.root.querySelector('.scc-log');
  assert.equal(log?.textContent, 'Saved job output');
  revision++;
  await view.refresh();
  assert.equal(view.root.querySelector<HTMLElement>('.scc-job__body')!.hidden, false);
  assert.equal(view.root.querySelector('.scc-log'), log);
});

test('run selection responds immediately, reuses details, and coalesces pending requests', async () => {
  const runs = [42, 43].map(id => ({ id, workflow: `CI ${id}`, title: `Build ${id}`, branch: 'main', sha: 'abc123', event: 'push', status: 'completed', conclusion: 'success', createdAt: '', updatedAt: '', url: '' }));
  const pending = new Map<number, (result: any) => void>();
  const calls: number[] = [];
  const { ctx } = setup(body => {
    if (body.op === 'runList') return { ok: true, runs };
    if (body.op === 'runView') {
      calls.push(body.id);
      return new Promise(resolve => pending.set(body.id, resolve));
    }
    return { ok: true };
  });
  view = createActionsView(ctx, { getForgeStatus: () => null });
  await flush();
  const detail = view.root.querySelector<HTMLElement>('.scc-split__detail')!;
  const row = (id: number) => view!.root.querySelector<HTMLElement>(`.scc-runrow[data-id="${id}"]`)!;
  const reply = (id: number) => pending.get(id)!({ ok: true, run: { ...runs.find(run => run.id === id), jobs: [{ id, name: `Job ${id}`, status: 'completed', conclusion: 'success', startedAt: '', completedAt: '', steps: [] }] } });
  assert.equal(detail.querySelector('h2')?.textContent, 'CI 42');
  assert.equal(detail.querySelector('[role="status"]')?.textContent, 'Loading jobs…');
  assert(detail.querySelector('.scc-run-loading__wheel'));
  reply(42);
  await flush();
  assert.equal(detail.getAttribute('aria-busy'), 'false');
  row(43).click();
  assert.equal(detail.querySelector('h2')?.textContent, 'CI 43');
  assert.equal(detail.querySelector('.scc-job'), null);
  assert.equal(detail.getAttribute('aria-busy'), 'true');
  await flush();
  row(42).click();
  assert.equal(detail.querySelector('.scc-job__name')?.textContent, 'Job 42');
  await flush();
  row(43).click();
  await flush();
  assert.equal(calls.filter(id => id === 43).length, 1);
  reply(42); // A stale response must not replace the selected run.
  await flush();
  assert.equal(detail.querySelector('h2')?.textContent, 'CI 43');
  const refresh = view.refresh();
  await flush();
  assert.equal(calls.filter(id => id === 43).length, 1);
  reply(43);
  await refresh;
  await flush();
  assert.equal(detail.querySelector('.scc-job__name')?.textContent, 'Job 43');
  assert.equal(detail.querySelector('[role="status"]'), null);
  row(43).click();
  assert.equal(calls.filter(id => id === 43).length, 1);
});

test('failed run loads clear the loading indicator and can be retried', async () => {
  let fail = true;
  const run = { id: 42, workflow: 'CI', title: 'Build', branch: 'main', sha: 'abc123', event: 'push', status: 'completed', conclusion: 'failure', createdAt: '', updatedAt: '', url: '' };
  const { ctx } = setup(body => body.op === 'runList' ? { ok: true, runs: [run] } : fail ? { ok: false, error: 'GitHub unavailable' } : { ok: true, run: { ...run, jobs: [] } });
  view = createActionsView(ctx, { getForgeStatus: () => null });
  await flush();
  const detail = view.root.querySelector('.scc-split__detail')!;
  assert.equal(detail.getAttribute('aria-busy'), 'false');
  assert.equal(detail.querySelector('.scc-run-loading__wheel'), null);
  assert(detail.textContent?.includes('GitHub unavailable'));
  fail = false;
  click('Retry');
  await flush();
  assert.equal(detail.querySelector('h2')?.textContent, 'CI');
  assert.equal(detail.querySelector('.scc-error'), null);
});

test('run detail cache and pending loads are isolated across workspace changes', async () => {
  const pending: Array<{ cwd: string; resolve: (result: any) => void }> = [];
  const run = { id: 42, workflow: 'CI', title: 'Build', branch: 'main', sha: 'abc123', event: 'push', status: 'completed', conclusion: 'success', createdAt: '', updatedAt: '', url: '' };
  const { ctx, switchRoot } = setup(body => body.op === 'runList' ? { ok: true, runs: [run] } : new Promise(resolve => pending.push({ cwd: body.cwd, resolve })));
  view = createActionsView(ctx, { getForgeStatus: () => null });
  await flush();
  switchRoot();
  const refresh = view.refresh();
  await flush();
  assert.deepEqual(pending.map(load => load.cwd), ['/repo', '/other']);
  pending[0]!.resolve({ ok: true, run: { ...run, title: 'Old workspace', jobs: [] } });
  await flush();
  const detail = view.root.querySelector('.scc-split__detail')!;
  assert(!detail.textContent?.includes('Old workspace'));
  assert.equal(detail.getAttribute('aria-busy'), 'true');
  pending[1]!.resolve({ ok: true, run: { ...run, title: 'New workspace', jobs: [] } });
  await refresh;
  await flush();
  assert(detail.textContent?.includes('New workspace'));
  assert.equal(detail.getAttribute('aria-busy'), 'false');
});
