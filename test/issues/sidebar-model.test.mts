import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sidebarIssues, splitQuickIssue } from '../../src/issues/sidebar-model.ts';
import { createDefaultIssuesTaxonomy } from '../../src/issues/taxonomy.ts';
import type { IssueCard } from '../../src/types.ts';

const taxonomy = createDefaultIssuesTaxonomy();
function issue(id: string, status: string, createdAt: number, workspacePath = 'C:/Projects/Minnow'): IssueCard {
  return { id, status, createdAt, updatedAt: createdAt, workspacePath, title: `Fix ${id}`, description: '', type: 'task', priority: 'none', labels: [] };
}

test('sidebar stays scoped to its workspace, normalizes Windows paths and sorts newest first', () => {
  const issues = [issue('MIN-1', 'backlog', 10), issue('MIN-2', 'in_progress', 30), issue('MIN-3', 'done', 40), issue('OTHER-1', 'backlog', 50, 'C:/Projects/Other')];
  assert.deepEqual(sidebarIssues(issues, 'c:\\projects\\minnow\\', taxonomy, 'open', '').map((row) => row.id), ['MIN-2', 'MIN-1']);
  assert.deepEqual(sidebarIssues(issues, 'C:/Projects/Minnow', taxonomy, 'closed', '').map((row) => row.id), ['MIN-3']);
  assert.equal(sidebarIssues(issues, 'C:/Projects/Minnow', taxonomy, 'all', '').length, 3);
});

test('search matches title and ID and custom closed statuses use the taxonomy', () => {
  const custom = { ...taxonomy, statuses: [...taxonomy.statuses, { id: 'archived', label: 'Archived', order: 99, isClosed: true }] };
  const issues = [issue('MIN-1', 'backlog', 10), issue('MIN-2', 'archived', 20)];
  assert.equal(sidebarIssues(issues, 'C:/Projects/Minnow', custom, 'open', 'MIN-2').length, 0);
  assert.equal(sidebarIssues(issues, 'C:/Projects/Minnow', custom, 'closed', 'fix').length, 1);
});

test('quick capture keeps the first line as title and preserves the remaining description', () => {
  assert.deepEqual(splitQuickIssue('  Preview loses focus\r\n\r\nSteps:\r\n1. Switch tabs  '), { title: 'Preview loses focus', description: 'Steps:\n1. Switch tabs' });
  assert.deepEqual(splitQuickIssue('  '), { title: '', description: '' });
});

test('property filters combine with workspace, open/closed and search filters', () => {
  const matching = { ...issue('MIN-1', 'in_progress', 10), type: 'bug', priority: 'high', projectId: 'release' };
  const issues = [matching,
    { ...matching, id: 'MIN-2', type: 'task' },
    { ...matching, id: 'MIN-3', priority: 'low' },
    { ...matching, id: 'MIN-4', status: 'backlog' },
    { ...matching, id: 'MIN-5', projectId: undefined },
    { ...matching, id: 'OTHER-1', workspacePath: 'C:/Projects/Other' },
  ];
  const properties = { type: 'bug', priority: 'high', status: 'in_progress', projectId: 'release' };
  assert.deepEqual(sidebarIssues(issues, matching.workspacePath, taxonomy, 'open', 'fix', properties), [matching]);
  assert.deepEqual(sidebarIssues(issues, matching.workspacePath, taxonomy, 'closed', '', properties), []);
  assert.deepEqual(sidebarIssues(issues, matching.workspacePath, taxonomy, 'all', 'missing', properties), []);
  assert.deepEqual(sidebarIssues(issues, matching.workspacePath, taxonomy, 'all', '', { projectId: null }).map((row) => row.id), ['MIN-5']);
});
