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

test('normalization key order and omitted optional fields do not look like edits', () => {
  const before = state({ chatIds: ['existing'], severity: undefined });
  const reordered = {
    ...before,
    issues: before.issues.map((card) => Object.fromEntries(
      Object.entries(card).filter(([, value]) => value !== undefined).reverse(),
    ) as IssueCard),
  };
  const remote = { ...before, issues: [{ ...before.issues[0], description: 'Remote edit', updatedAt: 2 }] };
  const stringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = ((...args: Parameters<typeof stringify>) => {
    calls += 1;
    return Reflect.apply(stringify, JSON, args);
  }) as typeof stringify;
  try {
    const unchanged = mergeIssuesState(before, before, reordered);
    assert.deepEqual(unchanged, reordered);
    assert.equal(calls, 0, 'an unchanged refresh must not serialize issue comparisons');
    assert.deepEqual(mergeIssuesState(before, reordered, remote), remote);
  } finally {
    JSON.stringify = stringify;
  }
});

test('bulk remote changes use a linear number of content signatures and preserve local edits', () => {
  const count = 300;
  const before = { ...base, issues: Array.from({ length: count }, (_, i) => ({
    ...issue, id: `MIN-${i + 1}`, title: `Issue ${i}`, description: 'Details μ'.repeat(100),
  })) };
  const local = { ...before, issues: before.issues.map((card, i) => i === 0 ? { ...card, title: 'Local edit' } : card) };
  const remote = { ...before, issues: before.issues.map((card) => ({ ...card, updatedAt: 2 })) };
  const stringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = ((...args: Parameters<typeof stringify>) => {
    calls += 1;
    return Reflect.apply(stringify, JSON, args);
  }) as typeof stringify;
  try {
    const merged = mergeIssuesState(before, local, remote);
    assert.equal(merged.issues.length, count);
    assert.equal(merged.issues[0].title, 'Local edit');
    assert.ok(merged.issues.every((card) => card.updatedAt === 2));
    assert.ok(calls <= count * 2, `expected at most two signatures per card, got ${calls}`);
    assert.equal(before.issues[0].title, 'Issue 0');
  } finally {
    JSON.stringify = stringify;
  }
});

test('pending edits follow a rekey even when the server reorders card properties', () => {
  const empty = { ...base, issues: [] };
  const before = state({ title: 'Mine' });
  const saved = mergeIssuesState(empty, before, state({ title: 'Theirs' }));
  saved.issues = saved.issues.map((card) => Object.fromEntries(Object.entries(card).reverse()) as IssueCard);
  const after = mergeIssuesState(before, state({ title: 'Mine', description: 'Pending edit' }), saved);
  assert.equal(after.issues.find((card) => card.title === 'Mine')?.description, 'Pending edit');
  assert.equal(after.issues.find((card) => card.title === 'Theirs')?.description, '');
});
