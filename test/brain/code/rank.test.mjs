/**
 * Deterministic PageRank and repo-map token budgeting (MIN-B7).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildAdjacency,
  buildPersonalizationVector,
  estimateTokens,
  personalizedPageRank,
} from '../../../server/brain/code/rank.js';
import { renderRepoMap } from '../../../server/brain/code/repo-map.js';

describe('code index rank', () => {
  it('personalizedPageRank is deterministic for the same graph', () => {
    const edges = [
      { src_symbol: 'ws:a', dst_symbol: 'ws:b' },
      { src_symbol: 'ws:b', dst_symbol: 'ws:c' },
      { src_symbol: 'ws:c', dst_symbol: 'ws:a' },
    ];
    const { out, nodes } = buildAdjacency(edges);
    const personal = new Map([
      ['ws:a', 0.5],
      ['ws:b', 0.3],
      ['ws:c', 0.2],
    ]);

    const first = personalizedPageRank(out, nodes, personal);
    const second = personalizedPageRank(out, nodes, personal);

    assert.equal(first.size, 3);
    for (const id of nodes) {
      assert.equal(first.get(id), second.get(id));
      assert.ok((first.get(id) ?? 0) > 0);
    }
  });

  it('buildPersonalizationVector boosts focus files', () => {
    const nodes = new Set(['ws:a', 'ws:b']);
    const symbols = [
      { id: 'ws:a', file: 'src/a.ts', usage_count: 0 },
      { id: 'ws:b', file: 'src/b.ts', usage_count: 0 },
    ];
    const focus = new Set(['src/a.ts']);
    const weights = buildPersonalizationVector(nodes, symbols, focus);
    assert.ok((weights.get('ws:a') ?? 0) > (weights.get('ws:b') ?? 0));
  });

  it('renderRepoMap walks symbols in rank order (not alphabetical files)', () => {
    const symbols = [
      { id: 'ws:a', file: 'src/z.ts', signature: 'function topRank()', kind: 'function', pagerank: 0.9 },
      { id: 'ws:b', file: 'src/a.ts', signature: 'function bottomRank()', kind: 'function', pagerank: 0.1 },
    ];
    const map = renderRepoMap(symbols, 200);
    const topAt = map.text.indexOf('topRank');
    const bottomAt = map.text.indexOf('bottomRank');
    assert.ok(topAt >= 0);
    assert.ok(bottomAt >= 0);
    assert.ok(topAt < bottomAt);
  });

  it('renderRepoMap respects the token budget', () => {
    const symbols = [];
    for (let i = 0; i < 200; i += 1) {
      symbols.push({
        id: `ws:fn${i}`,
        file: `src/file${i % 5}.ts`,
        signature: `function fn${i}(arg${i}: string): Promise<void>`,
        kind: 'function',
        pagerank: 1 - i * 0.001,
      });
    }
    const budget = 120;
    const map = renderRepoMap(symbols, budget);
    assert.ok(map.tokenEstimate <= budget + estimateTokens('- … (truncated to token budget)'));
    assert.match(map.text, /^# Repo map/);
    assert.equal(map.truncated, true);
  });

  it('renderRepoMap returns symbol ids for UI navigation', () => {
    const symbols = [
      { id: 'ws:main', file: 'src/app.ts', signature: 'function main()', kind: 'function', pagerank: 1 },
    ];
    const map = renderRepoMap(symbols, 200);
    const symbolEntry = map.entries?.find((entry) => entry.type === 'symbol');
    assert.ok(symbolEntry);
    assert.equal(symbolEntry.symbolId, 'ws:main');
    assert.equal(symbolEntry.file, 'src/app.ts');
  });

  // ── focus ──────────────────────────────────────────────────────────────────

  const focusSymbols = [
    { id: 'ws:top', file: 'src/app.ts', signature: 'function top()', kind: 'function', pagerank: 0.9 },
    { id: 'ws:mid', file: 'src/other.ts', signature: 'function mid()', kind: 'function', pagerank: 0.5 },
    { id: 'ws:low', file: 'src/tick.ts', signature: 'function low()', kind: 'function', pagerank: 0.1 },
  ];

  it('the tool profile filters to the focus terms', () => {
    const map = renderRepoMap(focusSymbols, 400, { focus: 'tick.ts' });
    assert.match(map.text, /low\(\)/);
    assert.doesNotMatch(map.text, /top\(\)/);
  });

  it('focus accepts several terms, matched as OR', () => {
    const map = renderRepoMap(focusSymbols, 400, { focus: ['tick.ts', 'other.ts'] });
    assert.match(map.text, /low\(\)/);
    assert.match(map.text, /mid\(\)/);
    assert.doesNotMatch(map.text, /top\(\)/);
  });

  it('the injection profile boosts a match to the front but keeps the rest', () => {
    const map = renderRepoMap(focusSymbols, 400, { focus: 'tick.ts', profile: 'injection' });
    const lowAt = map.text.indexOf('low()');
    const topAt = map.text.indexOf('top()');
    assert.ok(lowAt >= 0 && topAt >= 0, 'both the match and the ranked head are present');
    assert.ok(lowAt < topAt, 'the focus match outranks the higher-pagerank symbol');
  });

  it('a focus term that matches nothing still yields the ranked map on injection', () => {
    const map = renderRepoMap(focusSymbols, 400, { focus: 'nothingmatchesthis', profile: 'injection' });
    assert.match(map.text, /top\(\)/);
    assert.doesNotMatch(map.text, /no symbols matched/i);
  });

  it('a focus term that matches nothing says so for the tool', () => {
    const map = renderRepoMap(focusSymbols, 400, { focus: 'nothingmatchesthis' });
    assert.match(map.text, /no symbols matched focus/i);
  });
});
