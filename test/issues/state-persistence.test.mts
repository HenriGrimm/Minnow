import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { setIssuesStateForTests, refreshIssuesFromStorage, saveIssuesNow, findIssueById, updateIssue, deleteIssue } from '../../src/state/issues-store.ts';
import { clearIssuesListenersForTests, subscribeIssuesChanges } from '../../src/state/issues-events.ts';
import type { IssuesState } from '../../src/types.ts';
import { mergeIssuesState } from '../../src/issues/state-merge.ts';

const originalFetch = globalThis.fetch;
let persisted: IssuesState;
let onPut: (() => void) | undefined;
const base = (): IssuesState => ({ version: 2, nextId: 2, workspaces: {}, issues: [{ id: 'MIN-1', title: 'Original', description: '', type: 'task', status: 'todo', priority: 'none', labels: [], workspacePath: '/w', createdAt: 1, updatedAt: 1 }] });

beforeEach(() => {
  persisted = base();
  onPut = undefined;
  setIssuesStateForTests(base());
  setStorageModeForTests('server');
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      persisted = mergeIssuesState(body.base, body.state, persisted);
      onPut?.();
      return new Response(JSON.stringify({ ok: true, data: persisted }));
    }
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
