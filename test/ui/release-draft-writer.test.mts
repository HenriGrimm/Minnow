import assert from 'node:assert/strict';
import { test, mock, afterEach } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import serverDOMPurify from 'isomorphic-dompurify';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { setLocalServerAvailable } from '../../src/tools/config.ts';
import type { SccView } from '../../src/ui/scc-shared.ts';

let generate: (...args: any[]) => Promise<string>;
mock.module('../../src/ui/release-draft-client.ts', { namedExports: {
  writeReleaseDraft: (...args: any[]) => generate(...args),
} });
const { createReleasesView } = await import('../../src/ui/scc-releases.ts');
const originalFetch = globalThis.fetch;
const originalSanitize = DOMPurify.sanitize;
let win: Window;
let view: SccView;
afterEach(async () => {
  view?.destroy();
  globalThis.fetch = originalFetch;
  DOMPurify.sanitize = originalSanitize;
  await win?.happyDOM.close();
});
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
async function setup(overrides: Record<string, unknown> = {}, contextOverride = {}) {
  win = new Window();
  installHappyDomGlobals(win);
  setLocalServerAvailable(true);
  DOMPurify.sanitize = serverDOMPurify.sanitize;
  const release = { id: 1, tag: 'v2', title: 'Release 2', body: 'Original notes', target: 'main', draft: true, prerelease: false, immutable: false, url: '', assets: [], createdAt: '', ...overrides };
  const context = { repo: 'github.com/o/r', tag: 'v2', baseTag: 'v1', baseSha: 'a'.repeat(40), targetSha: 'b'.repeat(40), commitCount: 1, commits: [{ sha: 'b'.repeat(40), message: 'feat: navigation' }], ...contextOverride };
  const calls: any[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    return new Response(JSON.stringify(body.op === 'releaseList' ? { ok: true, releases: [release] }
      : body.op === 'releaseDraftContext' ? { ok: true, draftContext: context }
      : body.op === 'releaseEdit' ? { ok: true, release: { ...release, body: body.body } }
      : { ok: true, release, canWrite: overrides.canWrite ?? true }));
  };
  generate = async () => '## Features\n- Navigate with arrow keys.\n<script>alert(1)</script>';
  let cwd = '/repo';
  view = createReleasesView({ getCwd: () => cwd, getBranch: () => 'main', refreshAll: async () => {}, refreshSection: async () => {}, goTo: () => {}, setBadge: () => {} });
  win.document.body.append(view.root);
  await flush();
  return { calls, switchRoot: () => { cwd = '/other'; } };
}
function control(label: string) {
  const node = [...view.root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label);
  assert(node, label);
  return node;
}
function notes() { return view.root.querySelector<HTMLTextAreaElement>('textarea')!; }

test('drafts are ready to edit; generation previews safely and saves only explicitly', async () => {
  const { calls } = await setup();
  assert.equal(view.root.querySelector<HTMLElement>('.scc-release__editor')!.hidden, false);
  control('Generate with GitHub');
  control('Write draft').click();
  await flush();
  assert.match(notes().value, /Navigate with arrow keys/);
  const preview = view.root.querySelector('.scc-release__notes')!;
  assert.match(preview.textContent!, /Navigate with arrow keys/);
  assert.equal(preview.querySelector('script'), null);
  assert(!calls.some(call => call.op === 'releaseEdit'));
  assert.match(view.root.textContent!, /v1 → v2 \(bbbbbbbb\) · 1 commits/);
  await view.refresh();
  assert.match(notes().value, /Navigate with arrow keys/);
  control('Save changes').click();
  await flush();
  assert.match(calls.find(call => call.op === 'releaseEdit').body, /Navigate with arrow keys/);
});

test('Undo restores the exact preceding unsaved notes and preview', async () => {
  await setup();
  notes().value = 'My unsaved edits';
  control('Write draft').click();
  await flush();
  control('Undo').click();
  assert.equal(notes().value, 'My unsaved edits');
  assert.equal(view.root.querySelector('.scc-release__notes')!.textContent?.trim(), 'My unsaved edits');
});

test('busy state protects notes and release mutations; Cancel discards late output', async () => {
  await setup();
  let finish!: (value: string) => void;
  let signal!: AbortSignal;
  generate = async (_context, s) => { signal = s; return new Promise(resolve => { finish = resolve; }); };
  control('Write draft').click();
  await flush();
  assert(notes().readOnly);
  assert(control('Save changes').disabled);
  assert(control('Publish release').disabled);
  assert(control('Generate with GitHub').disabled);
  control('Cancel').click();
  assert(signal.aborted);
  assert(!notes().readOnly);
  finish('Stale notes');
  await flush();
  assert.equal(notes().value, 'Original notes');
  assert(!control('Save changes').disabled);
});

test('base overrides are sent and changing the base aborts generation', async () => {
  const { calls } = await setup();
  const base = view.root.querySelector<HTMLInputElement>('[aria-label="Previous tag override"]')!;
  base.value = 'custom/v1';
  let signal!: AbortSignal;
  generate = async (_context, s) => { signal = s; return new Promise(() => {}); };
  control('Write draft').click();
  await flush();
  assert.equal(calls.find(call => call.op === 'releaseDraftContext').previousTag, 'custom/v1');
  base.value = 'another';
  base.dispatchEvent(new win.Event('input'));
  assert(signal.aborted);
  assert.equal(notes().value, 'Original notes');
});

test('workspace changes, release selection, and destruction abort active work', async () => {
  const { switchRoot } = await setup();
  let signal!: AbortSignal;
  generate = async (_context, s) => { signal = s; return new Promise(() => {}); };
  control('Write draft').click();
  await flush();
  switchRoot();
  await view.refresh();
  assert(signal.aborted);
  await flush();
  control('Write draft').click();
  await flush();
  view.root.querySelector<HTMLButtonElement>('.scc-action-row')!.click();
  assert(signal.aborted);
  await flush();
  control('Write draft').click();
  await flush();
  view.destroy();
  assert(signal.aborted);
});

test('failures preserve edits and can be retried', async () => {
  await setup();
  generate = async () => { throw new Error('Provider unavailable'); };
  notes().value = 'Keep this';
  control('Write draft').click();
  await flush();
  assert.equal(notes().value, 'Keep this');
  assert.match(view.root.textContent!, /Provider unavailable.*retry/);
  generate = async () => 'Working notes';
  control('Write draft').click();
  await flush();
  assert.equal(notes().value, 'Working notes');
});

test('empty ranges skip inference and preserve notes', async () => {
  await setup({}, { commitCount: 0, commits: [] });
  generate = async () => { assert.fail('Must not generate'); };
  control('Write draft').click();
  await flush();
  assert.equal(notes().value, 'Original notes');
  assert.match(view.root.textContent!, /No new commits/);
});

test('published releases retain explicit editing and have no writer', async () => {
  await setup({ draft: false });
  assert.equal(view.root.querySelector('.scc-release-writer'), null);
  assert.equal(view.root.querySelector<HTMLElement>('.scc-release__editor')!.hidden, true);
  control('Edit release').click();
  assert.equal(view.root.querySelector<HTMLElement>('.scc-release__editor')!.hidden, false);
});

test('immutable and non-writable drafts have no writer', async () => {
  await setup({ immutable: true });
  assert.equal(view.root.querySelector('.scc-release-writer'), null);
  view.destroy();
  await win.happyDOM.close();
  await setup({ canWrite: false });
  assert.equal(view.root.querySelector('.scc-release-writer'), null);
});
