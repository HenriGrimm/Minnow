import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultIssuesTaxonomy } from '../../src/issues/taxonomy.ts';
import { flowColumn, groupIssues, batchIssues, blockers, parseDraftTasks } from '../../src/home/flow-model.ts';
import { parseHomeIssueRun } from '../../src/home/flow-run.ts';
import { parseIssuesState } from '../../src/state/issues-store.ts';
import type { IssueCard, HomeIssueRun } from '../../src/types.ts';
const taxonomy = createDefaultIssuesTaxonomy();
function issue(id: string, files: string[] = [], status = 'todo'): IssueCard {
  return { id, title: id, type: 'task', description: '', status, priority: 'none', labels: [], workspacePath: '/repo', createdAt: 1, updatedAt: 1, codeRefs: files.map(path => ({ path })) };
}
const home: HomeIssueRun = { groupId: 'group-one', state: 'held', mode: 'build', modelId: 'local-model', baseBranch: 'main' };
test('file grouping follows transitive linked-file overlap and keeps unknown work separate', () => {
  const rows = [issue('A', ['src/a.ts']), issue('B', ['src/b.ts']), issue('C', ['src/a.ts', 'src/b.ts']), issue('D'), issue('E')];
  const groups = groupIssues(rows, 'files').map(group => group.map(i => i.id).sort()).sort();
  assert.deepEqual(groups, [['A', 'B', 'C'], ['D'], ['E']]);
  assert.equal(groupIssues(rows, 'each').length, 5);
  assert.equal(groupIssues(rows, 'one').length, 1);
  assert.deepEqual(groupIssues([], 'one'), []);
});
test('custom taxonomy roles, triage identity and canceled issues map correctly', () => {
  const custom = { ...taxonomy, statuses: taxonomy.statuses.map(s => ({ ...s, id: `custom_${s.id}` })) };
  assert.equal(flowColumn(issue('A', [], 'custom_in_progress'), custom), 'progress');
  assert.equal(flowColumn(issue('B', [], 'custom_canceled'), custom), null);
  const triage = { ...issue('C', [], 'custom_todo'), source: 'agent' as const };
  assert.equal(flowColumn(triage, custom), 'triage');
  triage.triagedAt = 2;
  assert.equal(flowColumn(triage, custom), 'ready');
});
test('blockers release only when their real issue is closed; batch cards count each chat once', () => {
  const a = issue('A'), b = issue('B');
  b.issueRefs = [{ issueId: 'A', kind: 'blocked-by', addedAt: 1 }];
  assert.deepEqual(blockers(b, [a, b], taxonomy).map(i => i.id), ['A']);
  a.status = 'done'; assert.deepEqual(blockers(b, [a, b], taxonomy), []);
  for (const row of [a, b]) row.agent = { agentId: 'builder', phase: 'queued', startedAt: 1, updatedAt: 1, home };
  assert.equal(batchIssues([a, b]).length, 1);
  assert.equal(flowColumn(b, taxonomy), 'ready');
});
test('run metadata survives issue-store serialization and rejects malformed queue entries', () => {
  const row = issue('TEST-1'); row.agent = { agentId: 'builder', phase: 'queued', startedAt: 1, updatedAt: 1, home };
  const parsed = parseIssuesState({ version: 2, issues: [row] });
  assert.deepEqual(parsed.issues[0].agent?.home, home);
  assert.deepEqual(parseHomeIssueRun({ ...home, instructions: 'Check keyboard focus', state: 'paused' }), { ...home, instructions: 'Check keyboard focus', state: 'paused' });
  assert.equal(parseHomeIssueRun({ ...home, state: 'invented' }), undefined);
  assert.equal(parseHomeIssueRun({ ...home, groupId: '' }), undefined);
});
test('draft planning accepts structured tasks and rejects incomplete or excessive output', () => {
  assert.deepEqual(parseDraftTasks('```json\n{"tasks":[{"title":" Improve focus ","description":"Use the keyboard","files":["src/a.ts",9]}]}\n```'), [{ title: 'Improve focus', description: 'Use the keyboard', files: ['src/a.ts'] }]);
  assert.throws(() => parseDraftTasks('Done.'));
  assert.throws(() => parseDraftTasks('{"tasks":[{"description":"missing title"}]}'));
  assert.throws(() => parseDraftTasks(JSON.stringify({ tasks: Array.from({ length: 21 }, () => ({ title: 'Too many' })) })));
});
