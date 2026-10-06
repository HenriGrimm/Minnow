import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { validateIssuesState } from '../../server/config/validators.js';
import {
  addIssue,
  findIssueById,
  getNextIssueIdPreview,
  parseIssuesState,
  setIssuesStateForTests,
  setWorkspaceProjectKey,
  updateIssue,
} from '../../src/state/issues-store.ts';

const firstWorkspace = 'C:/work/website';
const secondWorkspace = 'C:/clients/website';
const card = (id: string, title: string, workspacePath: string) => ({
  id, title, workspacePath, description: '', type: 'task', status: 'todo',
  priority: 'none', labels: [], createdAt: 1, updatedAt: 1,
});

afterEach(() => setIssuesStateForTests(null));

test('same-basename workspaces allocate globally unique issue IDs', () => {
  setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
  const first = addIssue({ title: 'First', workspacePath: firstWorkspace });
  assert.equal(getNextIssueIdPreview(secondWorkspace), 'WEB-2');
  const second = addIssue({ title: 'Second', workspacePath: secondWorkspace });
  assert.deepEqual([first.id, second.id], ['WEB-1', 'WEB-2']);
  updateIssue(second.id, { title: 'Edited second' });
  assert.equal(findIssueById(first.id)?.title, 'First');
  assert.equal(findIssueById(second.id)?.title, 'Edited second');
});

test('same manually assigned key and worktree share one number sequence', () => {
  setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
  assert.deepEqual(setWorkspaceProjectKey('C:/work/alpha', 'APP'), { ok: true });
  assert.deepEqual(setWorkspaceProjectKey('C:/work/alpha/.worktrees/task', 'APP'), { ok: true });
  assert.equal(addIssue({ title: 'Main', workspacePath: 'C:/work/alpha' }).id, 'APP-1');
  assert.equal(addIssue({ title: 'Worktree', workspacePath: 'C:/work/alpha/.worktrees/task' }).id, 'APP-2');
});

test('client and server parsing preserve duplicate legacy rows with distinct IDs', () => {
  const raw = {
    version: 2, nextId: 1,
    issues: [
      card('WEB-1', 'First', firstWorkspace),
      card('WEB-1', 'Second', secondWorkspace),
      { ...card('WEB-2', 'Child', secondWorkspace), parentId: 'WEB-1' },
    ],
    workspaces: {
      [firstWorkspace]: { projectKey: 'WEB', nextId: 2 },
      [secondWorkspace]: { projectKey: 'WEB', nextId: 2 },
    },
  };
  for (const parsed of [parseIssuesState(raw), validateIssuesState(raw)]) {
    assert.deepEqual(parsed.issues.map((issue: { id: string }) => issue.id),
      ['WEB-1', 'WEB-3', 'WEB-2']);
    assert.equal(parsed.issues[2].parentId, 'WEB-3');
    assert.equal(parsed.workspaces?.[firstWorkspace]?.nextId, 4);
    assert.equal(parsed.workspaces?.[secondWorkspace]?.nextId, 4);
  }
});

test('explicit duplicate IDs are rejected before an ambiguous card is added', () => {
  setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
  addIssue({ title: 'First', workspacePath: firstWorkspace }, 'WEB-1');
  assert.throws(() => addIssue({ title: 'Second', workspacePath: secondWorkspace }, 'WEB-1'),
    /Issue ID WEB-1 already exists/);
});
