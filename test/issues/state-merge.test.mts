import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeIssuesState } from '../../src/issues/state-merge.ts';
import type { IssuesState, IssueCard } from '../../src/types.ts';

const issue = { id: 'MIN-1', title: 'Original', description: '', createdAt: 1, updatedAt: 1 } as IssueCard;
const base: IssuesState = { version: 2, nextId: 2, issues: [issue], workspaces: {} };
const state = (patch: Partial<IssueCard>): IssuesState => ({ ...base, issues: [{ ...issue, ...patch }] });

test('another window appending a chat does not overwrite a description edit', () => {
  const merged = mergeIssuesState(base, state({ chatIds: ['chat-1'], updatedAt: 4 }), state({ description: 'New description', updatedAt: 3 }));
  assert.equal(merged.issues[0].description, 'New description');
  assert.deepEqual(merged.issues[0].chatIds, ['chat-1']);
});
test('both local and remote deletions survive stale unrelated edits', () => {
  const deleted = { ...base, issues: [] };
  assert.deepEqual(mergeIssuesState(base, deleted, state({ title: 'Stale' })).issues, []);
  assert.deepEqual(mergeIssuesState(base, state({ title: 'Stale' }), deleted).issues, []);
});
test('unrelated newly created issues survive a stale window save', () => {
  const remote = { ...base, nextId: 3, issues: [issue, { ...issue, id: 'MIN-2' }] };
  const merged = mergeIssuesState(base, state({ title: 'Edited' }), remote);
  assert.equal(merged.issues.length, 2);
  assert.equal(merged.nextId, 3);
});
test('same-field conflicts use the newest issue edit', () => {
  const merged = mergeIssuesState(base, state({ title: 'Older', updatedAt: 2 }), state({ title: 'Newer', updatedAt: 3 }));
  assert.equal(merged.issues[0].title, 'Newer');
});
test('pending edits during persistence survive the saved snapshot merge', () => {
  const merged = mergeIssuesState(base, state({ description: 'Typed during PUT', updatedAt: 4 }), state({ chatIds: ['chat'], updatedAt: 2 }));
  assert.equal(merged.issues[0].description, 'Typed during PUT');
  assert.deepEqual(merged.issues[0].chatIds, ['chat']);
});

test('concurrent chat links and label additions merge while explicit removals win', () => {
  const old = state({ chatIds: ['existing'], labels: ['remove', 'keep'] });
  const left = state({ chatIds: ['existing', 'left'], labels: ['keep', 'left'] });
  const right = state({ chatIds: ['existing', 'right'], labels: ['remove', 'keep', 'right'] });
  const merged = mergeIssuesState(old, left, right);
  assert.deepEqual(new Set(merged.issues[0].chatIds), new Set(['existing', 'left', 'right']));
  assert.deepEqual(new Set(merged.issues[0].labels), new Set(['keep', 'left', 'right']));
});

test('simultaneous distinct creations with the same ID preserve both cards', () => {
  const empty = { ...base, issues: [] };
  const local = state({ title: 'My unsaved issue' });
  const remote = state({ title: 'Created in another window' });
  const merged = mergeIssuesState(empty, local, remote);
  assert.deepEqual(merged.issues.map((card) => card.id), ['MIN-1', 'MIN-2']);
  assert.deepEqual(new Set(merged.issues.map((card) => card.title)),
    new Set(['My unsaved issue', 'Created in another window']));
  assert.equal(local.issues[0].title, 'My unsaved issue');
});

test('an edit during a rekeyed save stays on its original card', () => {
  const empty = { ...base, issues: [] };
  const before = state({ title: 'Mine' });
  const other = state({ title: 'Theirs' });
  const saved = mergeIssuesState(empty, before, other);
  const pending = state({ title: 'Mine', description: 'Typed during save' });
  const after = mergeIssuesState(before, pending, saved);
  assert.equal(after.issues.find((card) => card.title === 'Mine')?.description, 'Typed during save');
  assert.equal(after.issues.find((card) => card.title === 'Theirs')?.description, '');
});
