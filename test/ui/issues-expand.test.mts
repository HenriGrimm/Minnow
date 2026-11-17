/**
 * Issues sparkles expander: expands a saved issue in place with a visible
 * in-flight indicator, then offers Undo.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import type { IssueCard } from '../../src/types.ts';
import { ISSUES_COMPAT_VERSION, ISSUES_SCHEMA_VERSION } from '../../src/types.ts';

const { setIssuesStateForTests, findIssueById } = await import(
  '../../src/state/issues-store.ts'
);
const { setLocalServerAvailableForTests, setToolConfigForTests } = await import(
  '../../src/tools/config.ts'
);
const { defaultToolConfig } = await import('../../src/config/defaults.ts');
const { startIssueExpandFromUi } = await import('../../src/ui/issues-expand-controls.ts');
const {
  cancelIssueExpand,
  canUndoIssueExpand,
  expandCreatedIssueInBackground,
  setExpandIssueFetcherForTests,
  undoIssueExpand,
} = await import('../../src/ui/issues-expand.ts');
const { resetIssueExpandStateForTests } = await import('../../src/ui/issues-expand-state.ts');
const { resetToastsForTests } = await import('../../src/ui/toast.ts');
const { closeIssueDetail, openIssueDetail } = await import(
  '../../src/ui/issues-detail.ts'
);

const FIXED_NOW = 1_710_000_006_000;

let domWindow: Window | null = null;

function setupDom(): void {
  const window = new Window({ url: 'http://localhost/' });
  domWindow = window;
  globalThis.window = window as unknown as Window & typeof globalThis.window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLButtonElement = window.HTMLButtonElement;
  globalThis.HTMLInputElement = window.HTMLInputElement;
  globalThis.HTMLSelectElement = window.HTMLSelectElement;
  globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
  globalThis.HTMLFormElement = window.HTMLFormElement;
  globalThis.HTMLParagraphElement = window.HTMLParagraphElement;
  globalThis.Node = window.Node;
  globalThis.Element = window.Element;
  globalThis.SVGElement = window.SVGElement;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  setLocalServerAvailableForTests(false);
  setToolConfigForTests(defaultToolConfig());

  document.body.innerHTML = `
    <main id="issuesView" class="issues-page">
      <div class="issues-shell">
        <div class="issues-body"></div>
      </div>
    </main>
    <div id="sDot"></div>
    <div id="sText"></div>
  `;
}

function seedIssue(over: Partial<IssueCard> = {}): IssueCard {
  const issue: IssueCard = {
    id: 'MIN-8',
    type: 'task',
    title: 'login broken',
    description: '',
    status: 'backlog',
    priority: 'none',
    labels: [],
    workspacePath: '/workspace',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    source: 'user',
    ...over,
  };
  setIssuesStateForTests({
    version: ISSUES_COMPAT_VERSION,
    schemaRevision: ISSUES_SCHEMA_VERSION,
    nextId: 9,
    issues: [issue],
    workspaces: {},
  });
  return issue;
}

beforeEach(() => {
  setupDom();
});

afterEach(() => {
  cancelIssueExpand();
  resetIssueExpandStateForTests();
  resetToastsForTests();
  setExpandIssueFetcherForTests(null);
  closeIssueDetail();
  setIssuesStateForTests(null);
  domWindow?.close();
  domWindow = null;
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function detailButton(selector: string): HTMLButtonElement {
  const btn = document.querySelector(`.issues-detail__header-actions ${selector}`);
  assert.ok(btn instanceof HTMLButtonElement, `${selector} should be mounted in the detail header`);
  return btn;
}

describe('issues expand in place', () => {
  test('expands the issue in place without opening an overlay, then offers Undo', async () => {
    seedIssue({ title: 'login broken', description: '' });
    setExpandIssueFetcherForTests(async () => ({
      draft: {
        title: 'Fix login save crash',
        description: 'Saving settings throws. Fill in repro from the stub.',
        type: 'bug',
        priority: 'high',
      },
    }));

    openIssueDetail('MIN-8');
    await startIssueExpandFromUi('MIN-8');
    await tick();

    assert.equal(document.querySelector('[role="dialog"]'), null, 'no review overlay opens');
    assert.equal(findIssueById('MIN-8')?.title, 'Fix login save crash');
    assert.match(findIssueById('MIN-8')?.description ?? '', /Saving settings throws/);
    assert.equal(findIssueById('MIN-8')?.type, 'bug');
    assert.equal(findIssueById('MIN-8')?.priority, 'high');

    const detailTitle = document.querySelector('.issues-detail__title');
    assert.ok(detailTitle instanceof HTMLTextAreaElement, 'detail pane stays open');
    assert.equal(detailTitle.value, 'Fix login save crash');

    const undo = detailButton('[data-issue-expand-undo]');
    assert.equal(undo.hidden, false, 'Undo is offered after expansion');
    undo.click();
    await tick();

    assert.equal(findIssueById('MIN-8')?.title, 'login broken');
    assert.equal(findIssueById('MIN-8')?.description, '');
    assert.equal(findIssueById('MIN-8')?.type, 'task');
    assert.equal(findIssueById('MIN-8')?.priority, 'none');
    assert.equal(canUndoIssueExpand('MIN-8'), false);
    assert.equal(detailButton('[data-issue-expand-undo]').hidden, true);
  });

  test('detail shows an in-progress indicator while the model runs', async () => {
    seedIssue({ title: 'thin', description: '' });
    let finish!: (value: { draft: { title: string; description: string } }) => void;
    setExpandIssueFetcherForTests(() => new Promise((resolve) => { finish = resolve; }));

    openIssueDetail('MIN-8');
    const run = startIssueExpandFromUi('MIN-8');
    await tick();

    const activity = document.querySelector('.issues-detail__run-state [data-issue-expansion-activity="MIN-8"]');
    assert.ok(activity instanceof HTMLElement);
    assert.equal(activity.hidden, false, 'Expanding indicator is visible');
    const sparkles = detailButton('[data-issue-expand]');
    assert.equal(sparkles.getAttribute('aria-busy'), 'true');
    assert.ok(sparkles.classList.contains('composer-expand-btn--busy'));
    assert.equal(detailButton('[data-issue-expand-undo]').hidden, true, 'no Undo while running');

    finish({ draft: { title: 'Fix login', description: 'Saving settings throws a null.' } });
    await run;
    await tick();

    const after = document.querySelector('.issues-detail__run-state [data-issue-expansion-activity="MIN-8"]');
    assert.ok(after instanceof HTMLElement);
    assert.equal(after.hidden, true, 'indicator clears when the run ends');
    assert.equal(detailButton('[data-issue-expand]').getAttribute('aria-busy'), 'false');
    assert.equal(detailButton('[data-issue-expand-undo]').hidden, false);
  });

  test('clicking the busy sparkles control cancels without writing', async () => {
    seedIssue({ title: 'thin', description: 'Keep this paragraph.' });
    let started = false;
    setExpandIssueFetcherForTests(() => new Promise(() => { started = true; }));

    openIssueDetail('MIN-8');
    void startIssueExpandFromUi('MIN-8');
    await tick();
    assert.equal(started, true);

    detailButton('[data-issue-expand]').click();
    await tick();
    await tick();

    assert.equal(detailButton('[data-issue-expand]').getAttribute('aria-busy'), 'false');
    const activity = document.querySelector('[data-issue-expansion-activity="MIN-8"]');
    assert.equal((activity as HTMLElement | null)?.hidden, true);
    assert.equal(findIssueById('MIN-8')?.title, 'thin');
    assert.equal(findIssueById('MIN-8')?.description, 'Keep this paragraph.');
    assert.equal(canUndoIssueExpand('MIN-8'), false);
  });

  test('fields edited while the model runs keep the user edit, and Undo leaves later edits alone', async () => {
    seedIssue({ title: 'thin', description: '', priority: 'low' });
    const { updateIssue } = await import('../../src/state/issues-store.ts');
    let finish!: (value: { draft: { title: string; description: string; priority: string } }) => void;
    setExpandIssueFetcherForTests(() => new Promise((resolve) => { finish = resolve; }));

    const run = startIssueExpandFromUi('MIN-8');
    await tick();
    updateIssue('MIN-8', { title: 'User title' });
    finish({ draft: { title: 'Model title', description: 'Model body.', priority: 'high' } });
    await run;

    assert.equal(findIssueById('MIN-8')?.title, 'User title');
    assert.equal(findIssueById('MIN-8')?.description, 'Model body.');
    assert.equal(findIssueById('MIN-8')?.priority, 'high');

    updateIssue('MIN-8', { priority: 'urgent' });
    assert.equal(undoIssueExpand('MIN-8'), true);
    assert.equal(findIssueById('MIN-8')?.title, 'User title');
    assert.equal(findIssueById('MIN-8')?.description, '');
    assert.equal(findIssueById('MIN-8')?.priority, 'urgent');
  });

  test('a failed expansion clears the indicator and leaves the issue unchanged', async () => {
    seedIssue({ title: 'thin', description: '' });
    setExpandIssueFetcherForTests(async () => ({ error: 'provider unavailable' }));

    openIssueDetail('MIN-8');
    await startIssueExpandFromUi('MIN-8');
    await tick();

    assert.equal(findIssueById('MIN-8')?.title, 'thin');
    assert.equal(canUndoIssueExpand('MIN-8'), false);
    assert.equal(detailButton('[data-issue-expand]').getAttribute('aria-busy'), 'false');
    const activity = document.querySelector('[data-issue-expansion-activity="MIN-8"]');
    assert.equal((activity as HTMLElement | null)?.hidden, true);
  });
});

describe('issues peek expand control', () => {
  test('peek header shows the sparkles expander on a backlog issue', () => {
    seedIssue({ status: 'backlog', title: 'thin', description: '' });
    openIssueDetail('MIN-8');

    const btn = document.querySelector('.issues-detail__header-actions [data-issue-expand]');
    assert.ok(btn instanceof HTMLButtonElement);
    assert.equal(btn.getAttribute('aria-label'), 'Expand issue');
    assert.equal(btn.dataset.issueExpand, 'MIN-8');
    assert.ok(btn.querySelector('.composer-expand-btn__icon'));
  });
});


test('unsaved expansion uses entered fields without creating or modifying an issue', async () => {
  seedIssue();
  const { expandUnsavedIssueDraft } = await import('../../src/ui/issues-expand.ts');
  setExpandIssueFetcherForTests(async (request) => {
    assert.equal(request.issue.title, 'Draft bug');
    assert.equal(request.issue.description, 'Entered detail');
    assert.deepEqual(request.issue.labels, ['ui']);
    return { draft: { title: 'Fix draft bug', description: 'Expanded detail', type: 'task', labels: ['ui', 'crash'], priority: 'high' } };
  });
  const draft = await expandUnsavedIssueDraft({
    id: '__new__', title: 'Draft bug', description: 'Entered detail', type: 'bug', labels: ['ui'], priority: 'none',
  }, new AbortController().signal);
  assert.equal(draft?.priority, 'high');
  assert.equal(draft?.type, 'task');
  assert.equal(findIssueById('__new__'), undefined);
  assert.equal(findIssueById('MIN-8')?.title, 'login broken');
});


test('late cancellation errors cannot clobber a replacement expansion', async () => {
  seedIssue();
  let rejectOld!: (error: Error) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  setExpandIssueFetcherForTests(() => new Promise((_resolve, reject) => { rejectOld = reject; markStarted(); }));
  const old = startIssueExpandFromUi('MIN-8');
  await started;
  cancelIssueExpand();
  setExpandIssueFetcherForTests(async () => ({ draft: { title: 'Current result', description: 'Keep this' } }));
  await startIssueExpandFromUi('MIN-8');
  rejectOld(new Error('Request aborted'));
  await old;
  assert.equal(findIssueById('MIN-8')?.title, 'Current result');
  assert.equal(canUndoIssueExpand('MIN-8'), true);
});


test('background expansion updates mounted activity and clears it on success and failure', async () => {
  const { createIssueExpansionActivity, isIssueBackgroundExpanding } = await import('../../src/ui/issues-background-activity.ts');
  seedIssue();
  const slot = createIssueExpansionActivity('MIN-8', '/workspace');
  document.body.appendChild(slot);
  let finish!: (result: { draft: { title: string; description: string } }) => void;
  setExpandIssueFetcherForTests(() => new Promise((resolve) => { finish = resolve; }));
  const pending = expandCreatedIssueInBackground('MIN-8');
  assert.equal(isIssueBackgroundExpanding('MIN-8', '/workspace'), true);
  assert.equal(slot.hidden, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  finish({ draft: { title: 'Login broken', description: 'Fix login' } });
  await pending;
  assert.equal(slot.hidden, true);
  assert.equal(findIssueById('MIN-8')?.description, 'Fix login');
  setExpandIssueFetcherForTests(async () => { throw new Error('provider unavailable'); });
  await expandCreatedIssueInBackground('MIN-8');
  assert.equal(isIssueBackgroundExpanding('MIN-8', '/workspace'), false);
  assert.equal(slot.hidden, true);
});


test('Expand and Create defers the first GitHub sync until expansion lands', async () => {
  const notify = await import('../../src/state/issues-github-notify.ts');
  const { addIssue } = await import('../../src/state/issues-store.ts');
  seedIssue();
  const synced: Array<{ id: string; title: string | undefined }> = [];
  const unsubscribe = notify.subscribeGithubSyncedFieldWrite((id) => {
    synced.push({ id, title: findIssueById(id)?.title });
  });
  try {
    let finish!: (result: { draft: { title: string; description: string } }) => void;
    setExpandIssueFetcherForTests(() => new Promise((resolve) => { finish = resolve; }));
    addIssue({ title: 'checkout fails', workspacePath: '/workspace' }, 'MIN-9', { deferGithubAutoSync: true });
    const pending = expandCreatedIssueInBackground('MIN-9');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(synced, [], 'creation must not sync before expansion');
    finish({ draft: { title: 'Checkout fails on save', description: 'Expanded body' } });
    await pending;
    assert.deepEqual(synced, [{ id: 'MIN-9', title: 'Checkout fails on save' }]);
    assert.equal(notify.isGithubSyncedFieldWriteDeferred('MIN-9'), false);

    synced.length = 0;
    setExpandIssueFetcherForTests(async () => { throw new Error('provider unavailable'); });
    addIssue({ title: 'second', workspacePath: '/workspace' }, 'MIN-10', { deferGithubAutoSync: true });
    assert.deepEqual(synced, []);
    await expandCreatedIssueInBackground('MIN-10');
    assert.deepEqual(synced, [{ id: 'MIN-10', title: 'second' }], 'failed expansion still syncs the created issue once');

    synced.length = 0;
    addIssue({ title: 'plain', workspacePath: '/workspace' }, 'MIN-11');
    assert.deepEqual(synced, [{ id: 'MIN-11', title: 'plain' }], 'plain create syncs immediately');
  } finally {
    unsubscribe();
  }
});


test('expansion activity receives snapshots, ignores stale updates and withdraws on window close', async () => {
  const activity = await import('../../src/ui/issues-background-activity.ts');
  activity.disposeIssueBackgroundActivity();
  const original = globalThis.BroadcastChannel;
  const sent: unknown[] = [];
  let receiver: ((event: { data: unknown }) => void) | undefined;
  let closed = false;
  class FakeChannel {
    set onmessage(fn: (event: { data: unknown }) => void) { receiver = fn; }
    postMessage(value: unknown) { sent.push(value); }
    close() { closed = true; }
  }
  globalThis.BroadcastChannel = FakeChannel as unknown as typeof BroadcastChannel;
  try {
    const slot = activity.createIssueExpansionActivity('MIN-8', '/workspace');
    document.body.append(slot);
    receiver!({ data: { kind: 'snapshot', owner: 'other-window', revision: 2, ids: ['/workspace::MIN-8'] } });
    assert.equal(slot.hidden, false);
    assert.equal(activity.createIssueExpansionActivity('MIN-8', '/unrelated').hidden, true);
    receiver!({ data: { kind: 'snapshot', owner: 'other-window', revision: 1, ids: [] } });
    assert.equal(slot.hidden, false);
    receiver!({ data: { kind: 'snapshot', owner: 'other-window', revision: 3, ids: [] } });
    assert.equal(slot.hidden, true);
    activity.setIssueBackgroundExpanding('MIN-8', true, '/workspace');
    const lateSlot = activity.createIssueExpansionActivity('MIN-8', '/workspace');
    assert.equal(lateSlot.hidden, false);
    receiver!({ data: { kind: 'request', owner: 'late-window' } });
    assert.deepEqual((sent.at(-1) as { ids: string[] }).ids, ['/workspace::MIN-8']);
    window.dispatchEvent(new window.Event('pagehide'));
    assert.deepEqual((sent.at(-1) as { ids: string[] }).ids, []);
    assert.equal(closed, true);
    assert.equal(slot.hidden, true);
  } finally {
    activity.disposeIssueBackgroundActivity();
    globalThis.BroadcastChannel = original;
  }
});
