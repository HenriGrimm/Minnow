/**
 * Pure graph builders for the Brain wiki graph.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPageGraph, filterGraphByQuery, neighborIds } from '../../src/ui/brain/graph/graph-data.ts';

const SAMPLE_PAGES = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Index',
    path: 'index.md',
    folder: '',
    slug: 'index',
    tags: ['core'],
    source: 'user',
    summary: 'Home',
    pinned: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    links: ['facts/note-a'],
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    title: 'Note A',
    path: 'facts/note-a.md',
    folder: 'facts',
    slug: 'note-a',
    tags: ['alpha'],
    source: 'user',
    summary: 'First note',
    pinned: false,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    links: ['index'],
  },
];

test('buildPageGraph creates page nodes and wikilink edges', () => {
  const { nodes, edges } = buildPageGraph(SAMPLE_PAGES, { includeTags: false });
  assert.equal(nodes.length, 2);
  assert.ok(nodes.some((n) => n.id === 'page:index.md'));
  assert.ok(edges.some((e) => e.kind === 'wikilink' && e.source === 'page:index.md'));
});

test('buildPageGraph adds tag nodes when enabled', () => {
  const { nodes } = buildPageGraph(SAMPLE_PAGES, { includeTags: true });
  assert.ok(nodes.some((n) => n.kind === 'tag' && n.label === 'core'));
  assert.ok(nodes.some((n) => n.kind === 'tag' && n.label === 'alpha'));
});

test('filterGraphByQuery keeps matching pages only', () => {
  const full = buildPageGraph(SAMPLE_PAGES);
  const filtered = filterGraphByQuery(full, 'note a');
  assert.equal(filtered.nodes.length, 1);
  assert.equal(filtered.nodes[0]?.path, 'facts/note-a.md');
});

test('neighborIds returns adjacent node ids', () => {
  const { edges } = buildPageGraph(SAMPLE_PAGES, { includeTags: false });
  const neighbors = neighborIds(edges, 'page:index.md');
  assert.ok(neighbors.has('page:index.md'));
  assert.ok(neighbors.has('page:facts/note-a.md'));
});
