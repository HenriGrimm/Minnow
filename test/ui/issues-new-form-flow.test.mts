import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';

const dom = new Window({ url: 'http://localhost/' });
for (const name of ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLFormElement', 'Node', 'NodeFilter', 'Element', 'SVGElement', 'AbortController', 'AbortSignal'] as const) {
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

const click = (id: string) => (document.getElementById(id) as HTMLElement).click();
const input = () => document.getElementById('issuesNewTitle') as HTMLInputElement;
const form = () => document.getElementById('issuesNewForm') as HTMLFormElement;

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), 'UI operation completed');
}

test('new issue quick add contains only a title input and two create actions', () => {
  click('btnIssuesNew');

  assert.deepEqual(
    [...form().children].map((element) => element.id || element.className),
    ['issuesNewTitle', 'issues-new-form__actions'],
  );
  assert.equal(form().querySelectorAll('input').length, 1);
  assert.deepEqual(
    [...form().querySelectorAll('button')].map((button) => button.textContent),
    ['Create Issue', 'Expand and Create'],
  );
  assert.equal(document.getElementById('issuesNewDescriptionHost'), null);
  assert.equal(document.getElementById('issuesNewLabelsHost'), null);
  assert.equal(document.getElementById('issuesNewType'), null);
  assert.equal(document.getElementById('issuesNewPriority'), null);
});

test('Create Issue files the typed title with default issue properties', () => {
  click('btnIssuesNew');
  input().value = 'Fix login failure';
  form().dispatchEvent(new dom.Event('submit', { cancelable: true }) as unknown as Event);

  const [issue] = store.listIssues();
  assert.equal(issue?.title, 'Fix login failure');
  assert.equal(issue?.description, '');
  assert.equal(issue?.type, 'task');
  assert.equal(issue?.priority, 'none');
  assert.deepEqual(issue?.labels, []);
  assert.equal(form().classList.contains('is-open'), false);
});

test('Expand and Create expands invisibly, then files the expanded draft', async () => {
  click('btnIssuesNew');
  input().value = 'Login fails';
  let seen = false;
  setExpandIssueFetcherForTests(async ({ issue }) => {
    assert.equal(issue.title, 'Login fails');
    seen = true;
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

  click('issuesNewExpandAndCreate');
  await until(() => store.listIssues().length === 1);

  const [issue] = store.listIssues();
  assert.ok(seen);
  assert.equal(issue?.title, 'Fix login failure');
  assert.equal(issue?.description, 'Reproduce and fix the sign-in error.');
  assert.equal(issue?.type, 'bug');
  assert.equal(issue?.priority, 'high');
  assert.deepEqual(issue?.labels, ['login']);
  assert.equal(form().classList.contains('is-open'), false);
});
