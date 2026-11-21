/**
 * Pure builders for the Brain memory graph: shared-vocabulary links and neighbor lookup.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMemoryGraph, memoryTokens, neighborIds } from '../../src/ui/brain/graph/graph-data.ts';

const limits = { title: 100, body: 1200, evidence: 300 };

function memory(id, partial = {}) {
  return {
    id,
    title: id,
    kind: 'decision',
    scope: 'project',
    body: '',
    evidence: '',
    supersedes: [],
    sourceChatId: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    revision: 'r',
    ...partial,
  };
}

const listing = (memories) => ({ project: { key: 'p', label: 'P' }, kinds: [], limits, memories });

test('memories that share vocabulary are linked, across kinds and scopes', () => {
  const { edges } = buildMemoryGraph(listing([
    memory('a', { title: 'Sessions store uses sqlite', body: 'sqlite sessions database migration' }),
    memory('b', { kind: 'gotcha', title: 'Sqlite sessions database locks', body: 'parallel writers lock sqlite' }),
    memory('c', { scope: 'user', kind: 'preference', title: 'Terse commit messages', body: 'gitmoji subjects' }),
  ]));
  const related = edges.filter((e) => e.kind === 'related').map((e) => [e.source, e.target].sort().join('|'));
  assert.deepEqual(related, ['mem:a|mem:b']);
});

test('each memory keeps at most two related links', () => {
  const words = 'alpha bravo charlie delta echo foxtrot';
  const many = Array.from({ length: 6 }, (_, i) => memory(`m${i}`, { title: `note ${i}`, body: words }));
  const { edges } = buildMemoryGraph(listing(many));
  const degree = new Map();
  for (const e of edges.filter((x) => x.kind === 'related')) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  assert.ok([...degree.values()].every((n) => n <= 2));
});

test('tokens skip short words and stopwords', () => {
  assert.deepEqual([...memoryTokens({ title: 'Use the sqlite store', body: 'when this runs' })].sort(), ['runs', 'sqlite', 'store']);
});

test('neighborIds includes the node and every adjacent id', () => {
  const edges = [
    { id: '1', source: 'a', target: 'b', kind: 'member' },
    { id: '2', source: 'c', target: 'a', kind: 'related' },
    { id: '3', source: 'd', target: 'e', kind: 'member' },
  ];
  assert.deepEqual([...neighborIds(edges, 'a')].sort(), ['a', 'b', 'c']);
});
