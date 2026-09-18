import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';

let dom: Window;
let store: typeof import('../../src/state/issues-store.ts');
let screen: typeof import('../../src/ui/issues-projects-screen.ts');

beforeEach(async () => {
  dom = new Window({ url: 'http://localhost/' });
  globalThis.window = dom as unknown as Window & typeof globalThis.window;
  globalThis.document = dom.document as unknown as Document;
  globalThis.HTMLElement = dom.HTMLElement as typeof HTMLElement;
  globalThis.HTMLButtonElement = dom.HTMLButtonElement as typeof HTMLButtonElement;
  globalThis.Node = dom.Node as typeof Node;
  globalThis.Element = dom.Element as typeof Element;
  store = await import('../../src/state/issues-store.ts');
  screen = await import('../../src/ui/issues-projects-screen.ts');
  store.setIssuesStateForTests({ version: 2, schemaRevision: 3, nextId: 1, issues: [] });
});

afterEach(() => {
  store.setIssuesStateForTests(null);
  dom.close();
});

test('renders a useful empty state and creates a project inline', () => {
  const mount = document.createElement('main');
  screen.renderIssuesProjectsScreen(mount, { onViewProject: () => {} });

  assert.match(mount.textContent ?? '', /No projects yet/);
  const input = mount.querySelector<HTMLInputElement>('#issuesProjectName');
  const form = mount.querySelector<HTMLFormElement>('.issues-project-create');
  assert.ok(input);
  assert.ok(form);
  input.value = 'Release 1.0';
  form.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }));

  assert.deepEqual(store.listIssueProjects().map((project) => project.name), ['Release 1.0']);
});

test('renders active and archived projects with progress actions', () => {
  const active = store.addIssueProject('Editor polish');
  const archived = store.addIssueProject('Old launch');
  store.archiveIssueProject(archived.id);
  let viewed = '';
  const mount = document.createElement('main');
  screen.renderIssuesProjectsScreen(mount, { onViewProject: (projectId) => { viewed = projectId; } });

  assert.match(mount.textContent ?? '', /Active 1/);
  assert.match(mount.textContent ?? '', /Archived 1/);
  assert.equal(mount.querySelectorAll('.issues-project-row').length, 2);
  assert.equal(mount.querySelectorAll('progress').length, 2);

  const activeRow = mount.querySelector<HTMLElement>(`[data-project-id="${active.id}"]`);
  const archivedRow = mount.querySelector<HTMLElement>(`[data-project-id="${archived.id}"]`);
  assert.ok(activeRow);
  assert.ok(archivedRow);
  [...activeRow.querySelectorAll('button')].find((button) => button.textContent === 'View issues')?.click();
  assert.equal(viewed, active.id);
  [...archivedRow.querySelectorAll('button')].find((button) => button.textContent === 'Restore')?.click();
  assert.equal(store.findIssueProject(archived.id)?.archivedAt, undefined);
});
