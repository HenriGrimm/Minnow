/**
 * Issues sparkles expander overlay: propose, review, apply or discard.
 * Nothing is written to the store until Apply.
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
const {
  closeIssueExpandOverlay,
  isIssueExpandOverlayOpen,
  startIssueExpandFromUi,
} = await import('../../src/ui/issues-expand-controls.ts');
const { setExpandIssueFetcherForTests } = await import('../../src/ui/issues-expand.ts');
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
  closeIssueExpandOverlay();
  setExpandIssueFetcherForTests(null);
  closeIssueDetail();
  setIssuesStateForTests(null);
  domWindow?.close();
  domWindow = null;
});

describe('issues expand overlay', () => {
  test('title-only expand proposes title and description without writing until Apply', async () => {
    seedIssue({ title: 'login broken', description: '' });
    setExpandIssueFetcherForTests(async (req) => {
      const draft = {
        title: 'Fix login save crash',
        description: 'Saving settings throws. Fill in repro from the stub.',
      };
      req.onPartial?.(draft);
      return { draft };
    });

    await startIssueExpandFromUi('MIN-8');

    assert.equal(isIssueExpandOverlayOpen(), true);
    assert.equal(findIssueById('MIN-8')?.title, 'login broken');
    assert.equal(findIssueById('MIN-8')?.description, '');

    const title = document.getElementById('issuesExpandTitle');
    const description = document.getElementById('issuesExpandDescription');
    assert.ok(title instanceof HTMLInputElement);
    assert.ok(description instanceof HTMLTextAreaElement);
    assert.equal(title.value, 'Fix login save crash');
    assert.match(description.value, /Saving settings throws/);
    assert.equal(title.readOnly, false);

    document.getElementById('issuesExpandApply')?.click();

    assert.equal(isIssueExpandOverlayOpen(), false);
    assert.equal(findIssueById('MIN-8')?.title, 'Fix login save crash');
    assert.match(findIssueById('MIN-8')?.description ?? '', /Saving settings throws/);
  });

  test('the overlay says it is working while the model streams', async () => {
    seedIssue({ title: 'thin', description: '' });
    let finish!: (value: { draft: { title: string; description: string } }) => void;
    let partial!: (draft: { title: string; description: string }) => void;
    setExpandIssueFetcherForTests((req) => {
      partial = (draft) => req.onPartial?.(draft);
      return new Promise((resolve) => { finish = resolve; });
    });

    const run = startIssueExpandFromUi('MIN-8');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const progress = document.getElementById('issuesExpandProgress');
    const status = document.getElementById('issuesExpandStatus');
    const discard = document.getElementById('issuesExpandDiscard');
    assert.ok(progress instanceof HTMLElement);
    assert.ok(status instanceof HTMLParagraphElement);
    assert.equal(progress.hidden, false, 'progress bar is up while streaming');
    assert.match(status.textContent ?? '', /Expanding/);
    // Discard is the cancel button while a run is in flight, so it says so.
    assert.equal(discard?.textContent, 'Cancel');

    partial({ title: 'Fix login', description: 'Saving settings throws a null.' });
    assert.match(status.textContent ?? '', /\d+ characters written/);

    finish({ draft: { title: 'Fix login', description: 'Saving settings throws a null.' } });
    await run;

    assert.equal(progress.hidden, true, 'progress bar comes down when the run ends');
    assert.equal(discard?.textContent, 'Discard');
    assert.match(status.textContent ?? '', /Expanded/);
  });

  test('cancelling takes the progress indicator down with the overlay', async () => {
    seedIssue({ title: 'thin', description: '' });
    let started = false;
    setExpandIssueFetcherForTests(() => new Promise(() => { started = true; }));
    void startIssueExpandFromUi('MIN-8');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(started, true);
    assert.equal(document.getElementById('issuesExpandProgress')?.hidden, false);

    // Cancel is the same control as Discard, relabelled while a run is in flight.
    document.getElementById('issuesExpandDiscard')?.click();
    assert.equal(document.getElementById('issuesExpandProgress')?.hidden, true);
    assert.equal(isIssueExpandOverlayOpen(), false);
  });

  test('existing details are not wiped on Discard', async () => {
    seedIssue({
      title: 'Login',
      description: 'Null when saving settings. Keep this paragraph.',
    });
    setExpandIssueFetcherForTests(async () => ({
      draft: {
        title: 'Fix login save crash',
        description: 'Improved write-up that should not land unless applied.',
      },
    }));

    await startIssueExpandFromUi('MIN-8');
    assert.equal(isIssueExpandOverlayOpen(), true);
    document.getElementById('issuesExpandDiscard')?.click();

    assert.equal(isIssueExpandOverlayOpen(), false);
    assert.equal(findIssueById('MIN-8')?.title, 'Login');
    assert.equal(
      findIssueById('MIN-8')?.description,
      'Null when saving settings. Keep this paragraph.',
    );
  });

  test('user edits in the overlay are what Apply writes', async () => {
    seedIssue({ title: 'thin', description: '' });
    setExpandIssueFetcherForTests(async () => ({
      draft: { title: 'Proposed title', description: 'Proposed body.' },
    }));

    await startIssueExpandFromUi('MIN-8');
    const title = document.getElementById('issuesExpandTitle');
    const description = document.getElementById('issuesExpandDescription');
    assert.ok(title instanceof HTMLInputElement);
    assert.ok(description instanceof HTMLTextAreaElement);
    title.value = 'Edited title';
    description.value = 'Edited body that keeps the proposal as a starting point.';
    document.getElementById('issuesExpandApply')?.click();

    assert.equal(findIssueById('MIN-8')?.title, 'Edited title');
    assert.equal(
      findIssueById('MIN-8')?.description,
      'Edited body that keeps the proposal as a starting point.',
    );
  });

  test('apply refreshes the open detail pane without switching issues', async () => {
    seedIssue({ title: 'login broken', description: '' });
    setExpandIssueFetcherForTests(async (req) => {
      const draft = {
        title: 'Fix login save crash',
        description: 'Saving settings throws. Fill in repro from the stub.',
      };
      req.onPartial?.(draft);
      return { draft };
    });

    openIssueDetail('MIN-8');
    await startIssueExpandFromUi('MIN-8');
    assert.equal(isIssueExpandOverlayOpen(), true);

    document.getElementById('issuesExpandApply')?.click();

    assert.equal(findIssueById('MIN-8')?.title, 'Fix login save crash');
    // The detail refresh rides a dynamic import; let its microtask land.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const detailTitle = document.querySelector('.issues-detail__title');
    assert.ok(detailTitle instanceof HTMLInputElement, 'detail pane should still be open');
    assert.equal(detailTitle.value, 'Fix login save crash');
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


test('metadata remains a proposal until Apply, with editable type, labels, and priority', async () => {
  seedIssue({ labels: ['ui'], priority: 'low' });
  setExpandIssueFetcherForTests(async () => ({ draft: {
    title: 'Fix login', description: 'Crash on login', type: 'bug', labels: ['ui', 'crash'], priority: 'high',
  } }));
  await startIssueExpandFromUi('MIN-8');
  assert.deepEqual(findIssueById('MIN-8')?.labels, ['ui']);
  assert.equal(findIssueById('MIN-8')?.priority, 'low');
  const labels = document.getElementById('issuesExpandLabels') as HTMLTextAreaElement;
  const type = document.getElementById('issuesExpandType') as HTMLSelectElement;
  const priority = document.getElementById('issuesExpandPriority') as HTMLSelectElement;
  assert.equal(type.value, 'bug');
  assert.equal(labels.value, 'ui\ncrash');
  assert.equal(priority.value, 'high');
  labels.value = 'login';
  type.value = 'idea';
  priority.value = 'urgent';
  document.getElementById('issuesExpandApply')?.click();
  assert.deepEqual(findIssueById('MIN-8')?.labels, ['login']);
  assert.equal(findIssueById('MIN-8')?.type, 'idea');
  assert.equal(findIssueById('MIN-8')?.priority, 'urgent');
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


test('late cancellation errors cannot close a replacement expansion', async () => {
  seedIssue();
  const expand = await import('../../src/ui/issues-expand.ts');
  let rejectOld!: (error: Error) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  setExpandIssueFetcherForTests(() => new Promise((_resolve, reject) => { rejectOld = reject; markStarted(); }));
  const old = expand.startIssueExpandFromUi('MIN-8');
  await started;
  expand.closeIssueExpandOverlay();
  setExpandIssueFetcherForTests(async () => ({ draft: { title: 'Current result', description: 'Keep this' } }));
  await startIssueExpandFromUi('MIN-8');
  rejectOld(new Error('Request aborted'));
  await old;
  assert.equal(isIssueExpandOverlayOpen(), true);
  assert.equal((document.getElementById('issuesExpandTitle') as HTMLInputElement).value, 'Current result');
});
