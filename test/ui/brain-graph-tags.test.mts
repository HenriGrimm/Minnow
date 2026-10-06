import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildPageGraph } from '../../src/ui/brain/graph/graph-data.ts';
import type { BrainPageMeta } from '../../src/brain/types.ts';

function page(index: number, tags: string[] = ['shared', `topic-${index}`]): BrainPageMeta {
  return {
    id: String(index),
    title: `Page ${index}`,
    path: `facts/page-${index}.md`,
    folder: 'facts',
    slug: `page-${index}`,
    tags,
    source: 'manual',
    summary: '',
    pinned: false,
    createdAt: '',
    updatedAt: '',
    links: [],
  };
}

describe('buildPageGraph tags (MIN-129)', () => {
  test('shows unique tags and links every page to its shared tag', () => {
    const graph = buildPageGraph([page(0), page(1)]);
    assert.equal(graph.nodes.filter((node) => node.kind === 'tag').length, 3);
    assert.equal(graph.edges.filter((edge) => edge.target === 'tag:shared').length, 2);
    assert.equal(graph.truncated, false);
    assert.equal(graph.hiddenCount, 0);
  });

  test('retains tags when tags alone push a small catalog over the limit', () => {
    const graph = buildPageGraph([page(0), page(1)], { maxNodes: 4 });
    assert.deepEqual(new Set(graph.nodes.map((node) => node.id)), new Set([
      'page:facts/page-0.md', 'tag:shared', 'tag:topic-0', 'page:facts/page-1.md',
    ]));
    assert.equal(graph.truncated, true);
    assert.equal(graph.hiddenCount, 1);
    assert.equal(graph.edges.filter((edge) => edge.target === 'tag:shared').length, 2);
  });

  test('retains tags and valid edges in a catalog exceeding the default limit', () => {
    const pages = Array.from({ length: 300 }, (_, index) => page(index));
    pages[0].links = ['facts/page-1', 'missing'];
    pages[0].similarTo = ['facts/page-1'];
    const graph = buildPageGraph(pages);
    const ids = new Set(graph.nodes.map((node) => node.id));
    assert.equal(graph.nodes.length, 250);
    assert.equal(graph.truncated, true);
    assert.equal(graph.hiddenCount, 352);
    assert.ok(ids.has('tag:shared'));
    assert.ok(ids.has('tag:topic-0'));
    assert.ok(graph.edges.some((edge) => edge.kind === 'tag'));
    assert.ok(graph.edges.some((edge) => edge.kind === 'wikilink'));
    assert.ok(graph.edges.some((edge) => edge.kind === 'similar'));
    assert.ok(graph.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target)));
    for (const node of graph.nodes.filter((node) => node.kind === 'tag')) {
      assert.ok(graph.edges.some((edge) => edge.target === node.id));
    }
  });

  test('hiding tags keeps the page budget and removes tag edges', () => {
    const graph = buildPageGraph(Array.from({ length: 300 }, (_, index) => page(index)), {
      includeTags: false,
    });
    assert.equal(graph.nodes.length, 250);
    assert.equal(graph.hiddenCount, 50);
    assert.ok(graph.nodes.every((node) => node.kind === 'page'));
    assert.ok(graph.edges.every((edge) => edge.kind !== 'tag'));
  });

  test('does not truncate at the exact limit', () => {
    const graph = buildPageGraph([page(0)], { maxNodes: 3 });
    assert.equal(graph.nodes.length, 3);
    assert.equal(graph.truncated, false);
    assert.equal(graph.hiddenCount, 0);
  });
});
