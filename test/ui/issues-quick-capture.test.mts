import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';

const dom = new Window({ url: 'http://localhost/' });
for (const name of ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLFormElement', 'HTMLParagraphElement', 'Node', 'NodeFilter', 'Element', 'SVGElement', 'AbortController', 'AbortSignal'] as const) {
  (globalThis as Record<string, unknown>)[name] = name === 'window' ? dom : dom[name];
}
globalThis.getComputedStyle = dom.getComputedStyle.bind(dom) as typeof getComputedStyle;
document.body.innerHTML = '<main id="issuesView"></main><div id="sDot"></div><div id="sText"></div>';

const { initIssuesPage } = await import('../../src/ui/issues-page.ts');
const { setExpandIssueFetcherForTests } = await import('../../src/ui/issues-expand.ts');
const store = await import('../../src/state/issues-store.ts');
store.setIssuesStateForTests({ version: 2, schemaRevision: 3, nextId: 1, issues: [] });
initIssuesPage();

after(() => {
  setExpandIssueFetcherForTests(null);
  store.setIssuesStateForTests(null);
  dom.close();
});

beforeEach(() => {
  setExpandIssueFetcherForTests(null);
  store.setIssuesStateForTests({ version: 2, schemaRevision: 3, nextId: 1, issues: [] });
});

const input = () => document.getElementById('issuesQuickCapture') as HTMLInputElement;
const click = (id: string) => (document.getElementById(id) as HTMLElement).click();

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), 'UI operation completed');
}

test('header quick capture has only the title input and its two creation actions', () => {
  const controls = document.querySelector('.issues-quick-capture');
  assert.ok(controls);
  assert.deepEqual(
    [...controls.querySelectorAll('input, button')].map((element) => element.textContent || element.id),
    ['issuesQuickCapture', 'Create Issue', 'Expand and Create'],
  );
});

test('Create Issue files the title from header quick capture', () => {
  input().value = 'Fix login failure';
  click('issuesQuickCaptureCreate');

  assert.equal(store.listIssues()[0]?.title, 'Fix login failure');
  assert.equal(input().value, '');
});

test('Expand and Create expands in the background, then files the expanded issue', async () => {
  input().value = 'Login fails';
  setExpandIssueFetcherForTests(async ({ issue }) => {
    assert.equal(issue.title, 'Login fails');
    return {
      draft: {
        title: 'Fix login failure',
        description: 'Reproduce and fix the sign-in error.',
        type: 'bug',
        priority: 'high',
        labels: ['login'],
      },
    };
  });

  click('issuesQuickCaptureExpandAndCreate');
  await until(() => store.listIssues().length === 1);

  const [issue] = store.listIssues();
  assert.equal(issue?.title, 'Fix login failure');
  assert.equal(issue?.description, 'Reproduce and fix the sign-in error.');
  assert.equal(issue?.type, 'bug');
  assert.equal(issue?.priority, 'high');
  assert.deepEqual(issue?.labels, ['login']);
  assert.equal(input().value, '');
});
