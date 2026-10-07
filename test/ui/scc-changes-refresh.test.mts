import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { setLocalServerAvailable } from '../../src/tools/config.ts';
import { createChangesView } from '../../src/ui/scc-changes.ts';
import type { SccView } from '../../src/ui/scc-shared.ts';
import type { GitOpResult } from '../../src/state/git-api.ts';

const originalFetch = globalThis.fetch;
let win: Window;
let view: SccView;
let status: GitOpResult;
let patch: string;
let cwd: string;
const makePatch = (text: string) => `diff --git a/src/file-0.ts b/src/file-0.ts\n--- a/src/file-0.ts\n+++ b/src/file-0.ts\n@@ -1 +1 @@\n-old\n+${text}\n`;

function setup(): void {
  win = new Window();
  installHappyDomGlobals(win);
  Object.assign(globalThis, { HTMLInputElement: win.HTMLInputElement, HTMLTextAreaElement: win.HTMLTextAreaElement });
  setLocalServerAvailable(true);
  cwd = '/workspace';
  status = { ok: true, unstaged: Array.from({ length: 81 }, (_, i) => ({ path: `src/file-${i}.ts`, status: 'M' })) };
  patch = makePatch('new');
  globalThis.fetch = (async (_url, init) => {
    const { op } = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(op === 'status' ? status : { ok: true, patch }));
  }) as typeof fetch;
  view = createChangesView({ getCwd: () => cwd, getBranch: () => 'main', refreshAll: async () => view.refresh(), refreshSection: async () => view.refresh(), goTo() {}, setBadge() {} });
  document.body.append(view.root);
}

afterEach(async () => {
  view?.destroy();
  globalThis.fetch = originalFetch;
  await win?.happyDOM.close();
});

test('unchanged polls preserve 81 file rows and the selected diff, while edits still update', async () => {
  setup();
  await view.refresh();
  const row = view.root.querySelector<HTMLElement>('.scc-filerow')!;
  row.click();
  await view.refresh();
  const list = view.root.querySelector<HTMLElement>('.scc-changes__list')!;
  const diff = view.root.querySelector<HTMLElement>('.scc-changes__diff-body')!;
  const diffContent = diff.firstElementChild;
  let removed = 0;
  const observer = new win.MutationObserver((records) => {
    removed += records.reduce((sum, record) => sum + record.removedNodes.length, 0);
  });
  observer.observe(list, { childList: true, subtree: true });
  observer.observe(diff, { childList: true, subtree: true });
  for (let i = 0; i < 3; i++) await view.refresh();
  removed += observer.takeRecords().reduce((sum, record) => sum + record.removedNodes.length, 0);
  observer.disconnect();
  assert.equal(removed, 0, `unchanged polls removed ${removed} DOM nodes`);
  assert.equal(list.querySelector('.scc-filerow'), row);
  assert.equal(diff.firstElementChild, diffContent);

  patch = makePatch('changed again');
  await view.refresh();
  assert.match(diff.textContent ?? '', /changed again/);
  assert.notEqual(diff.firstElementChild, diffContent);
  assert.equal(list.querySelector('.scc-filerow'), row);

  status = { ok: true, staged: [{ path: 'src/file-0.ts', status: 'M' }] };
  await view.refresh();
  assert.equal(list.querySelectorAll('.scc-filerow').length, 1);
  assert.equal(list.querySelector<HTMLElement>('.scc-filerow')?.dataset.bucket, 'staged');
});

test('error recovery and workspace changes invalidate cached content', async () => {
  setup();
  await view.refresh();
  const previous = view.root.querySelector('.scc-filerow');
  cwd = '/other-workspace';
  await view.refresh();
  assert.notEqual(view.root.querySelector('.scc-filerow'), previous);
  status = { ok: false, error: 'Git unavailable' };
  await view.refresh();
  assert.match(view.root.textContent ?? '', /Git unavailable/);
  status = { ok: true, unstaged: [{ path: 'recovered.ts', status: 'M' }] };
  await view.refresh();
  assert.equal(view.root.querySelector<HTMLElement>('.scc-filerow')?.dataset.path, 'recovered.ts');
});

test('late diff replies cannot replace a newer selection of the same path in another bucket', async () => {
  setup();
  status = { ok: true, staged: [{ path: 'shared.ts', status: 'M' }], unstaged: [{ path: 'shared.ts', status: 'M' }] };
  await view.refresh();
  const replies: ((response: Response) => void)[] = [];
  globalThis.fetch = (() => new Promise<Response>((resolve) => replies.push(resolve))) as typeof fetch;
  view.root.querySelector<HTMLElement>('[data-bucket="staged"]')!.click();
  view.root.querySelector<HTMLElement>('[data-bucket="unstaged"]')!.click();
  assert.equal(replies.length, 2);
  replies[1](new Response(JSON.stringify({ ok: true, patch: makePatch('working copy') })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  replies[0](new Response(JSON.stringify({ ok: true, patch: makePatch('stale staged copy') })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const diff = view.root.querySelector('.scc-changes__diff-body')!;
  assert.match(diff.textContent ?? '', /working copy/);
  assert.doesNotMatch(diff.textContent ?? '', /stale staged copy/);
  assert.equal(view.root.querySelector('.scc-changes__diff-scope')?.textContent, 'Working tree');
});

test('late status replies cannot restore an older list after a newer refresh', async () => {
  setup();
  await view.refresh();
  const replies: ((response: Response) => void)[] = [];
  globalThis.fetch = (() => new Promise<Response>((resolve) => replies.push(resolve))) as typeof fetch;
  const older = view.refresh();
  const newer = view.refresh();
  replies[1](new Response(JSON.stringify({ ok: true, unstaged: [{ path: 'newer.ts', status: 'M' }] })));
  await newer;
  replies[0](new Response(JSON.stringify(status)));
  await older;
  assert.equal(view.root.querySelectorAll('.scc-filerow').length, 1);
  assert.equal(view.root.querySelector<HTMLElement>('.scc-filerow')?.dataset.path, 'newer.ts');
});
