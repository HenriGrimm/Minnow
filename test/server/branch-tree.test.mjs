/**
 * Unit tests for branch parent inference (Source Control branch tree).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  inferBranchParents,
  parseBranchReflogHead,
  parseUpstreamTrack,
} from '../../server/git/branch-tree.js';

/** `{ child: [parents] }` → `git rev-list --parents` text, newest first. */
function revList(graph) {
  return Object.entries(graph).reverse().map(([sha, parents]) => [sha, ...parents].join(' ')).join('\n');
}

function parents(result) {
  return Object.fromEntries([...result].map(([name, entry]) => [name, entry.parent]));
}

describe('inferBranchParents', () => {
  // m0 ← m1 ← m2 (main)
  //       ↖ a1 ← a2 (feature)
  //               ↖ b1 (stacked)
  const graph = { m0: [], m1: ['m0'], m2: ['m1'], a1: ['m1'], a2: ['a1'], b1: ['a2'] };

  test('stacks a branch on the closest fork point and roots the trunk', () => {
    const result = inferBranchParents({
      revList: revList(graph),
      trunk: 'main',
      branches: [
        { name: 'main', sha: 'm2' },
        { name: 'feature', sha: 'a2' },
        { name: 'stacked', sha: 'b1' },
      ],
    });
    assert.deepEqual(parents(result), { main: null, feature: 'main', stacked: 'feature' });
    assert.deepEqual(result.get('feature'), { parent: 'main', ahead: 2, behind: 1, merged: false });
    assert.deepEqual(result.get('stacked'), { parent: 'feature', ahead: 1, behind: 0, merged: false });
  });

  test('a base that moved on stays the parent of the younger branch', () => {
    // feature forked stacked at a1, then gained a2: the graph is symmetric.
    const result = inferBranchParents({
      revList: revList({ m0: [], m1: ['m0'], a1: ['m1'], a2: ['a1'], b1: ['a1'] }),
      trunk: 'main',
      branches: [
        { name: 'main', sha: 'm1', createdAt: 1 },
        { name: 'feature', sha: 'a2', createdAt: 2 },
        { name: 'stacked', sha: 'b1', createdAt: 3 },
      ],
    });
    assert.deepEqual(parents(result), { main: null, feature: 'main', stacked: 'feature' });
  });

  test('fresh branches at the trunk tip sit under the trunk, not each other', () => {
    const result = inferBranchParents({
      revList: revList(graph),
      trunk: 'main',
      branches: [
        { name: 'main', sha: 'm2' },
        { name: 'x', sha: 'm2' },
        { name: 'y', sha: 'm2' },
      ],
    });
    assert.deepEqual(parents(result), { main: null, x: 'main', y: 'main' });
  });

  test('reflog Created from breaks a tie', () => {
    const result = inferBranchParents({
      revList: revList(graph),
      trunk: 'main',
      branches: [
        { name: 'main', sha: 'm2' },
        { name: 'x', sha: 'm1' },
        { name: 'y', sha: 'm1', createdFrom: 'x' },
      ],
    });
    assert.equal(result.get('y')?.parent, 'x');
  });

  test('a branch merged into the trunk keeps the trunk as parent and is flagged', () => {
    // main merged feature at mm; stacked was merged along with it.
    const merged = { ...graph, mm: ['m2', 'b1'] };
    const result = inferBranchParents({
      revList: revList(merged),
      trunk: 'main',
      branches: [
        { name: 'main', sha: 'mm' },
        { name: 'feature', sha: 'a2' },
        { name: 'stacked', sha: 'b1' },
      ],
    });
    assert.deepEqual(parents(result), { main: null, feature: 'main', stacked: 'feature' });
    assert.equal(result.get('feature')?.merged, true);
    assert.equal(result.get('stacked')?.merged, true);
  });

  test('unknown tips and unrelated histories become roots', () => {
    const result = inferBranchParents({
      revList: revList({ ...graph, o1: [] }),
      trunk: 'main',
      branches: [
        { name: 'main', sha: 'm2' },
        { name: 'orphan', sha: 'o1' },
        { name: 'gone', sha: 'zz' },
      ],
    });
    assert.deepEqual(parents(result), { main: null, orphan: null, gone: null });
  });
});

describe('branch tree parsers', () => {
  test('reads creation time and start point from the first reflog line', () => {
    assert.deepEqual(
      parseBranchReflogHead('0000 abcd Henri <h@x.org> 1789169195 -0700\tbranch: Created from origin/main\nnext'),
      { createdAt: 1789169195, createdFrom: 'origin/main' },
    );
    assert.deepEqual(parseBranchReflogHead(''), { createdAt: undefined, createdFrom: undefined });
  });

  test('parses upstream track state', () => {
    assert.deepEqual(parseUpstreamTrack('ahead 2, behind 3'), { ahead: 2, behind: 3, gone: false });
    assert.deepEqual(parseUpstreamTrack('gone'), { ahead: 0, behind: 0, gone: true });
    assert.deepEqual(parseUpstreamTrack(''), { ahead: 0, behind: 0, gone: false });
  });
});
