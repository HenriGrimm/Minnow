import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';

const dom = new Window({ url: 'http://localhost/' });
for (const name of ['window', 'document', 'localStorage', 'HTMLElement', 'HTMLLabelElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLFormElement', 'HTMLParagraphElement', 'Node', 'NodeFilter', 'Element', 'SVGElement', 'AbortController', 'AbortSignal'] as const) {
  (globalThis as Record<string, unknown>)[name] = name === 'window' ? dom : dom[name];
}
globalThis.getComputedStyle = dom.getComputedStyle.bind(dom) as typeof getComputedStyle;
document.body.innerHTML = '<button id="capture">New issue</button><div id="sDot"></div><div id="sText"></div>';
const { openQuickCapture } = await import('../../src/ui/issue-capture.ts');
const { resetIssueCaptureForTests } = await import('../../src/ui/issue-capture-popover.ts');
const { setExpandIssueFetcherForTests } = await import('../../src/ui/issues-expand.ts');
const { createDefaultIssuesTaxonomy } = await import('../../src/issues/taxonomy.ts');
const { setIssuesTaxonomyForTests } = await import('../../src/state/issues-taxonomy-store.ts');
const store = await import('../../src/state/issues-store.ts');
const config = await import('../../src/tools/config.ts');
config.setLocalServerAvailableForTests(false);

beforeEach(() => {
  resetIssueCaptureForTests();
  document.getElementById('btnIssuesNewCancel')?.click();
  store.setIssuesStateForTests({ version: 2, schemaRevision: 3, nextId: 1, issues: [] });
  setExpandIssueFetcherForTests(null);
});
after(() => {
  resetIssueCaptureForTests();
  setIssuesTaxonomyForTests(null);
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

const threadCapture = () => document.querySelector<HTMLElement>('.mn-capture--thread')!;
function openThreadCapture(): HTMLElement {
  openQuickCapture({
    thread: true,
    anchor: document.getElementById('capture'),
    extra: { workspacePath: '/project', items: [{ kind: 'chat', label: 'Build thread', chatId: 'chat-1' }] },
  });
  return threadCapture();
}

function chooseCaptureProperty(label: string, id: string): void {
  threadCapture().querySelector<HTMLElement>(`[aria-label^="${label}:"]`)!.click();
  const row = document.querySelector<HTMLButtonElement>(`.mn-menu [data-id="${id}"]`);
  assert.ok(row, `${id} is available in ${label}`);
  row.click();
}

test('thread capture uses Issues taxonomy and keeps the chosen properties in the draft', async () => {
  const taxonomy = createDefaultIssuesTaxonomy();
  taxonomy.types.push({ id: 'incident', label: 'Incident', order: 10 });
  taxonomy.priorities.push({ id: 'someday', label: 'Someday', order: 10 });
  taxonomy.statuses.find((status) => status.role === 'triage')!.label = 'Intake';
  setIssuesTaxonomyForTests(taxonomy);
  try {
    const panel = openThreadCapture();
    assert.ok(panel.querySelector('[aria-label="Type: Task"]'));
    assert.ok(panel.querySelector('[aria-label="Priority: None"]'));
    assert.ok(panel.querySelector('[aria-label="Status: Intake"]'));
    panel.querySelector<HTMLInputElement>('.mn-capture__title')!.value = 'Capture selected fields';
    panel.querySelector<HTMLTextAreaElement>('.mn-capture__notes')!.value = 'Keep these details.';
    chooseCaptureProperty('Type', 'incident');
    chooseCaptureProperty('Priority', 'urgent');
    chooseCaptureProperty('Priority', 'someday');
    chooseCaptureProperty('Status', 'backlog');
    panel.querySelector<HTMLButtonElement>('button[aria-label="Add label"]')!.click();
    const label = document.querySelector<HTMLInputElement>('.issues-labels-popover input')!;
    label.value = 'regression';
    label.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
    label.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as Event);
    label.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event);
    assert.equal(document.querySelector('.issues-labels-popover'), null);
    assert.ok(panel.isConnected);
    panel.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked = false;
    panel.querySelector<HTMLButtonElement>('.mn-capture__cancel')!.click();

    const restored = openThreadCapture();
    assert.ok(restored.querySelector('[aria-label="Type: Incident"]'));
    assert.ok(restored.querySelector('[aria-label="Priority: Someday"]'));
    assert.ok(restored.querySelector('[aria-label="Status: Backlog"]'));
    assert.equal(restored.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked, false);
    restored.querySelector<HTMLButtonElement>('.mn-capture__submit')!.click();
    await until(() => !threadCapture());
    const [issue] = store.listIssues();
    assert.equal(issue.title, 'Capture selected fields');
    assert.equal(issue.description, 'Keep these details.');
    assert.equal(issue.type, 'incident');
    assert.equal(issue.priority, 'someday');
    assert.equal(issue.status, 'backlog');
    assert.deepEqual(issue.labels, ['regression']);
    assert.equal(issue.chatIds?.length ?? 0, 0);
  } finally {
    setIssuesTaxonomyForTests(null);
  }
});

test('Expand and Capture files a linked issue before running background expansion', async () => {
  let finish!: (value: { draft: { title: string; description: string } }) => void;
  let seen: { title: string; description?: string; type: string; priority?: string } | undefined;
  setExpandIssueFetcherForTests(({ issue }) => {
    seen = issue;
    return new Promise((resolve) => { finish = resolve; });
  });
  const panel = openThreadCapture();
  panel.querySelector<HTMLInputElement>('.mn-capture__title')!.value = 'Investigate sign-in';
  panel.querySelector<HTMLTextAreaElement>('.mn-capture__notes')!.value = 'Sign-in fails after a timeout.';
  chooseCaptureProperty('Type', 'bug');
  chooseCaptureProperty('Priority', 'high');
  const expand = panel.querySelector<HTMLButtonElement>('.mn-capture__expand-and-create')!;
  assert.equal(expand.textContent, 'Expand and Capture');
  expand.click();
  expand.click();
  await until(() => Boolean(finish));
  assert.equal(threadCapture(), null);
  assert.equal(store.listIssues().length, 1);
  const [issue] = store.listIssues();
  assert.equal(seen?.title, 'Investigate sign-in');
  assert.equal(seen?.description, 'Sign-in fails after a timeout.');
  assert.equal(seen?.type, 'bug');
  assert.equal(seen?.priority, 'high');
  assert.equal(issue.status, 'triage');
  assert.deepEqual(issue.chatIds, ['chat-1']);
  finish({ draft: { title: 'Fix sign-in timeout', description: 'Reproduce the timeout during sign-in.' } });
  await until(() => store.listIssues()[0]?.title === 'Fix sign-in timeout');
});

test('legacy thread drafts restore their category as a type', async () => {
  localStorage.setItem('minnow-issue-capture-draft-v1', JSON.stringify({
    '/project': {
      title: 'Existing draft',
      payload: { workspacePath: '/project', items: [] },
      threadFields: { label: 'Feature', priority: 'medium', linkedChatId: 'chat-1', link: false },
    },
  }));
  const panel = openThreadCapture();
  assert.ok(panel.querySelector('[aria-label="Type: Feature"]'));
  assert.ok(panel.querySelector('[aria-label="Priority: Medium"]'));
  assert.equal(panel.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked, false);
  panel.querySelector<HTMLButtonElement>('.mn-capture__submit')!.click();
  await until(() => !threadCapture());
  const [issue] = store.listIssues();
  assert.equal(issue.type, 'feature');
  assert.deepEqual(issue.labels, []);
});
