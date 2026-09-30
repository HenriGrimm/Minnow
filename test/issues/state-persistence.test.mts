import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { setIssuesStateForTests, refreshIssuesFromStorage, saveIssuesNow, findIssueById, updateIssue, deleteIssue, addIssue, loadIssuesFromStorage, isIssuesStoreRecovering } from '../../src/state/issues-store.ts';
import { clearIssuesListenersForTests, subscribeIssuesChanges } from '../../src/state/issues-events.ts';
import type { IssuesState } from '../../src/types.ts';
import { mergeIssuesState } from '../../src/issues/state-merge.ts';

const originalFetch = globalThis.fetch;
let persisted: IssuesState;
let onPut: (() => void) | undefined;
let failGet = false;
let putCount = 0;
const base = (): IssuesState => ({ version: 2, nextId: 2, workspaces: {}, issues: [{ id: 'MIN-1', title: 'Original', description: '', type: 'task', status: 'todo', priority: 'none', labels: [], workspacePath: '/w', createdAt: 1, updatedAt: 1 }] });

beforeEach(() => {
  persisted = base();
  onPut = undefined;
  failGet = false;
  putCount = 0;
  setIssuesStateForTests(base());
  setStorageModeForTests('server');
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'PUT') {
      putCount += 1;
      const body = JSON.parse(String(init.body));
      persisted = mergeIssuesState(body.base, body.state, persisted);
      onPut?.();
      return new Response(JSON.stringify({ ok: true, data: persisted }));
    }
    if (failGet) throw new Error('Temporary config outage');
    return new Response(JSON.stringify(persisted));
  };
});
afterEach(() => {
  clearIssuesListenersForTests();
  setIssuesStateForTests(null);
  setStorageModeForTests(null);
  globalThis.fetch = originalFetch;
});

test('unchanged persistence does not notify UI subscribers', async () => {
  // Let storage parsing add any schema defaults before observing steady-state writes.
  await refreshIssuesFromStorage();
  let changes = 0;
  subscribeIssuesChanges(() => { changes += 1; });

  await refreshIssuesFromStorage();
  await saveIssuesNow();

  assert.equal(changes, 0);
});

test('save merges another window changes before writing', async () => {
  persisted.issues[0].chatIds = ['remote-chat'];
  persisted.issues[0].updatedAt = 2;
  updateIssue('MIN-1', { description: 'Local unsaved description' });
  await saveIssuesNow();
  assert.equal(persisted.issues[0].description, 'Local unsaved description');
  assert.deepEqual(persisted.issues[0].chatIds, ['remote-chat']);
});
test('refresh preserves an unsaved deletion', async () => {
  deleteIssue('MIN-1');
  persisted.issues[0].chatIds = ['remote-chat'];
  await refreshIssuesFromStorage();
  assert.equal(findIssueById('MIN-1'), undefined);
  await saveIssuesNow();
  assert.deepEqual(persisted.issues, []);
});
test('an edit during PUT stays in memory and is written on the next save', async () => {
  updateIssue('MIN-1', { title: 'Sent title' });
  onPut = () => updateIssue('MIN-1', { description: 'Typed during request' });
  await saveIssuesNow();
  assert.equal(persisted.issues[0].description, '');
  assert.equal(findIssueById('MIN-1')?.description, 'Typed during request');
  onPut = undefined;
  await saveIssuesNow();
  assert.equal(persisted.issues[0].description, 'Typed during request');
});

test('failed first load retains existing issues when a new issue is saved after recovery', async () => {
  setIssuesStateForTests(null);
  failGet = true;
  await loadIssuesFromStorage();
  assert.equal(isIssuesStoreRecovering(), true);
  addIssue({ title: 'New issue after recovery', workspacePath: '/w' }, 'MIN-2');
  await loadIssuesFromStorage();
  assert.equal(findIssueById('MIN-2')?.title, 'New issue after recovery');
  await assert.rejects(saveIssuesNow(), /Temporary config outage/);
  assert.equal(putCount, 0);

  failGet = false;
  await saveIssuesNow();
  assert.deepEqual(persisted.issues.map(issue => issue.title).sort(), ['New issue after recovery', 'Original']);
  assert.equal(isIssuesStoreRecovering(), false);
});

test('refresh after failed first load merges pending additions without treating old issues as deletions', async () => {
  setIssuesStateForTests(null);
  failGet = true;
  await loadIssuesFromStorage();
  addIssue({ title: 'New issue after recovery', workspacePath: '/w' }, 'MIN-2');

  failGet = false;
  await refreshIssuesFromStorage();
  assert.equal(findIssueById('MIN-1')?.title, 'Original');
  assert.equal(findIssueById('MIN-2')?.title, 'New issue after recovery');
  assert.equal(isIssuesStoreRecovering(), false);
  await saveIssuesNow();
  assert.deepEqual(persisted.issues.map(issue => issue.title).sort(), ['New issue after recovery', 'Original']);
});
