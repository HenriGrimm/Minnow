import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';

let dom: Window;
let store: typeof import('../../src/state/issues-store.ts');
let popover: typeof import('../../src/ui/issue-capture-popover.ts');

beforeEach(async () => {
  dom = new Window({ url: 'http://localhost/' });
  globalThis.window = dom as unknown as Window & typeof globalThis.window;
  globalThis.document = dom.document as unknown as Document;
  globalThis.HTMLElement = dom.HTMLElement as typeof HTMLElement;
  globalThis.HTMLInputElement = dom.HTMLInputElement as typeof HTMLInputElement;
  globalThis.Node = dom.Node as typeof Node;
  globalThis.Element = dom.Element as typeof Element;
  store = await import('../../src/state/issues-store.ts');
  popover = await import('../../src/ui/issue-capture-popover.ts');
  store.setIssuesStateForTests({ version: 2, schemaRevision: 3, nextId: 1, issues: [] });
});

afterEach(() => {
  popover.closeIssueCapture({ restoreFocus: false, clearDraft: true });
  popover.resetIssueCaptureForTests();
  store.setIssuesStateForTests(null);
  dom.close();
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), 'UI operation completed');
}

test('global quick capture only renders an input, Create Issue, and Expand and Create', async () => {
  const { openQuickCapture } = await import('../../src/ui/issue-capture.ts');
  openQuickCapture();

  const root = document.querySelector('.mn-capture--minimal');
  assert.ok(root);
  assert.deepEqual(
    [...root.querySelectorAll('input, button')].map((element) =>
      element.tagName === 'INPUT' ? element.getAttribute('aria-label') : element.textContent,
    ),
    ['Issue title', 'Create Issue', 'Expand and Create'],
  );
  assert.equal(root.querySelector('.mn-capture__chips'), null);
  assert.equal(root.querySelector('.mn-capture__destination'), null);
});

test('Expand and Create expands in the background, then creates the issue', async () => {
  const { setExpandIssueFetcherForTests } = await import('../../src/ui/issues-expand.ts');
  const { openQuickCapture } = await import('../../src/ui/issue-capture.ts');
  setExpandIssueFetcherForTests(async ({ issue }) => {
    assert.equal(issue.title, 'Login fails');
    return { draft: {
      title: 'Fix login failure', description: 'Reproduce and fix the sign-in error.',
      type: 'bug', priority: 'high', labels: ['login'],
    } };
  });

  try {
    openQuickCapture();
    const input = document.querySelector('.mn-capture__title') as HTMLInputElement;
    input.value = 'Login fails';
    (document.querySelector('.mn-capture__expand-and-create') as HTMLButtonElement).click();
    await until(() => store.listIssues().length === 1);

    const [issue] = store.listIssues();
    assert.equal(issue?.title, 'Fix login failure');
    assert.equal(issue?.description, 'Reproduce and fix the sign-in error.');
    assert.equal(issue?.type, 'bug');
    assert.equal(issue?.priority, 'high');
    assert.deepEqual(issue?.labels, ['login']);
  } finally {
    setExpandIssueFetcherForTests(null);
  }
});
