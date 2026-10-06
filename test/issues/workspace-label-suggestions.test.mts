import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { collectIssueLabelSuggestions, setIssuesStateForTests } from '../../src/state/issues-store.ts';
import type { IssueCard } from '../../src/types.ts';

const issue = (id: string, workspacePath: string, labels: string[]): IssueCard => ({
  id, workspacePath, labels, type: 'task', title: id, description: '',
  status: 'todo', priority: 'none', createdAt: 1, updatedAt: 1,
});

afterEach(() => setIssuesStateForTests(null));

test('labels belong to the edited workspace, including closed cards and normalized Windows paths', () => {
  setIssuesStateForTests({
    version: 2, nextId: 4, workspaces: {},
    labelCatalog: [{ name: 'Orphan', color: 'clay' }],
    issues: [
      issue('MIN-1', 'C:/Projects/One', ['API']),
      { ...issue('MIN-2', 'c:\\projects\\one\\', ['api', 'UX']), status: 'done' },
      issue('MIN-3', 'C:/Projects/Two', ['Other']),
      issue('MIN-4', '', ['Scratch']),
    ],
  });
  assert.deepEqual(collectIssueLabelSuggestions('MIN-1'), ['API', 'UX']);
  assert.deepEqual(collectIssueLabelSuggestions('MIN-3'), ['Other']);
  assert.deepEqual(collectIssueLabelSuggestions('__new__', 'C:/Projects/One/'), ['API', 'UX']);
  assert.deepEqual(collectIssueLabelSuggestions('__new__', ''), ['Scratch']);
  assert.deepEqual(collectIssueLabelSuggestions('__new__', 'C:/Projects/Empty'), []);
});
