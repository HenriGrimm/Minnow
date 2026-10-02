import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';

const dom = new Window({ url: 'http://localhost/' });
for (const name of ['window', 'document', 'HTMLElement', 'HTMLLabelElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLFormElement', 'HTMLParagraphElement', 'Node', 'NodeFilter', 'Element', 'SVGElement', 'AbortController', 'AbortSignal'] as const) {
  (globalThis as Record<string, unknown>)[name] = name === 'window' ? dom : dom[name];
}
globalThis.getComputedStyle = dom.getComputedStyle.bind(dom) as typeof getComputedStyle;
document.body.innerHTML = '<button id="capture">New issue</button><div id="sDot"></div><div id="sText"></div>';
const { openQuickCapture } = await import('../../src/ui/issue-capture.ts');
const { setExpandIssueFetcherForTests } = await import('../../src/ui/issues-expand.ts');
const store = await import('../../src/state/issues-store.ts');
const config = await import('../../src/tools/config.ts');
config.setLocalServerAvailableForTests(false);

beforeEach(() => {
  document.getElementById('btnIssuesNewCancel')?.click();
  store.setIssuesStateForTests({ version: 2, schemaRevision: 3, nextId: 1, issues: [] });
  setExpandIssueFetcherForTests(null);
});
after(() => {
  document.getElementById('btnIssuesNewCancel')?.click();
  store.setIssuesStateForTests(null);
  setExpandIssueFetcherForTests(null);
  dom.close();
});
const form = () => document.getElementById('issuesNewForm') as HTMLFormElement;
const title = () => document.getElementById('issuesNewTitle') as HTMLInputElement;
const body = () => document.querySelector('#issuesNewDescriptionHost .mn-editor__body') as HTMLElement;
const click = (id: string) => document.getElementById(id)!.click();
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), 'UI operation completed');
}
async function open(): Promise<void> {
  openQuickCapture({ restoreFocus: document.getElementById('capture') });
  await until(() => Boolean(form()?.classList.contains('is-open')));
}

test('global quick capture uses the full form without opening the Issues app', async () => {
  await open();
  assert.ok(document.getElementById('issuesNewTypeHost'));
  assert.ok(document.getElementById('issuesNewPriorityHost'));
  assert.ok(document.getElementById('issuesNewLabelsHost'));
  assert.ok(body());
  assert.equal(document.querySelector('.mn-capture--minimal'), null);
  assert.equal(window.location.hash, '');
  title().value = 'Keep the entered details';
  body().querySelector('p')!.textContent = 'Full description from quick capture.';
  (document.getElementById('issuesNewType') as HTMLInputElement).value = 'bug';
  form().dispatchEvent(new dom.Event('submit', { cancelable: true }) as unknown as Event);
  await until(() => !form().classList.contains('is-open'));
  assert.equal(store.listIssues()[0].description, 'Full description from quick capture.');
  assert.equal(store.listIssues()[0].type, 'bug');
  assert.equal(document.activeElement?.id, 'capture');
});

test('Expand and Create saves and closes before generation finishes, and survives reopening', async () => {
  let finish!: (value: { draft: { title: string; description: string; type: string; priority: string; labels: string[] } }) => void;
  setExpandIssueFetcherForTests(async ({ issue }) => {
    assert.equal(issue.title, 'Login fails');
    assert.equal(issue.description, 'Clicking login fails.');
    assert.equal(issue.type, 'bug');
    return new Promise((resolve) => { finish = resolve; });
  });
  await open();
  title().value = 'Login fails';
  (document.getElementById('issuesNewType') as HTMLInputElement).value = 'bug';
  body().querySelector('p')!.textContent = 'Clicking login fails.';
  click('issuesNewExpandAndCreate');
  click('issuesNewExpandAndCreate');
  await until(() => Boolean(finish));
  assert.equal(form().classList.contains('is-open'), false);
  assert.equal(store.listIssues().length, 1);
  assert.equal(store.listIssues()[0].title, 'Login fails');
  await open();
  title().value = 'A different draft';
  finish({ draft: { title: 'Fix login failure', description: 'Reproduce and fix the sign-in error.', type: 'bug', priority: 'high', labels: ['login'] } });
  await until(() => store.listIssues()[0].title === 'Fix login failure');
  assert.equal(title().value, 'A different draft');
  assert.ok(form().classList.contains('is-open'));
  assert.equal(store.listIssues()[0].priority, 'high');
  assert.deepEqual(store.listIssues()[0].labels, ['login']);
});

test('background expansion preserves edits made to the saved issue', async () => {
  let finish!: (value: { draft: { title: string; description: string } }) => void;
  setExpandIssueFetcherForTests(async () => new Promise((resolve) => { finish = resolve; }));
  await open();
  title().value = 'Original title';
  click('issuesNewExpandAndCreate');
  await until(() => Boolean(finish));
  const issue = store.listIssues()[0];
  store.updateIssue(issue.id, { title: 'My edited title' });
  finish({ draft: { title: 'AI title', description: 'Expanded details' } });
  await until(() => issue.description === 'Expanded details');
  assert.equal(issue.title, 'My edited title');
});

test('failed expansion leaves the created issue intact', async () => {
  let finish!: (value: { draft: null; error: string }) => void;
  setExpandIssueFetcherForTests(async () => new Promise((resolve) => { finish = resolve; }));
  await open();
  title().value = 'Preserve this issue';
  click('issuesNewExpandAndCreate');
  await until(() => Boolean(finish));
  finish({ draft: null, error: 'Provider unavailable' });
  await until(() => Boolean(document.body.textContent?.includes('Provider unavailable')));
  assert.equal(store.listIssues()[0].title, 'Preserve this issue');
  assert.equal(form().classList.contains('is-open'), false);
});

test('captured context keeps its workspace and links in the full form', async () => {
  openQuickCapture({ extra: {
    workspacePath: 'C:/project', title: 'Investigate file',
    items: [{ kind: 'code', label: 'a.ts', text: 'Broken code', codeRef: { path: 'a.ts', startLine: 4 } }],
  } });
  await until(() => Boolean(form()?.classList.contains('is-open')));
  assert.equal(title().value, 'Investigate file');
  form().dispatchEvent(new dom.Event('submit', { cancelable: true }) as unknown as Event);
  await until(() => !form().classList.contains('is-open'));
  const issue = store.listIssues()[0];
  assert.equal(issue.workspacePath, 'C:/project');
  assert.equal(issue.codeRefs?.[0].path, 'a.ts');
  assert.match(issue.description, /Broken code/);
});
