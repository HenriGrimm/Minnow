/**
 * Repo-map symbol filtering and formatting.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderRepoMap } from '../../../server/brain/code/repo-map.js';
import {
  formatRepoMapInjectionLine,
  formatRepoMapSymbolLine,
  isRepoMapInjectionTestPath,
  isRepoMapVendorPath,
  isRepoMapTestPath,
  prepareRepoMapSymbols,
  prepareRepoMapSymbolsForInjection,
} from '../../../server/brain/code/repo-map-symbols.js';

describe('repo-map symbols', () => {
  it('excludes property noise and omits test paths', () => {
    const rows = [
      {
        id: 'ws:src/core.ts:dispatch',
        file: 'src/core.ts',
        kind: 'function',
        signature: 'function dispatch(): void',
        pagerank: 0.4,
        usage_count: 2,
        line_start: 1,
      },
      {
        id: 'ws:test/a.test.ts:status',
        file: 'test/a.test.ts',
        kind: 'property',
        signature: 'property status',
        pagerank: 0.99,
        usage_count: 0,
        line_start: 10,
      },
      {
        id: 'ws:test/a.test.ts:helper',
        file: 'test/a.test.ts',
        kind: 'function',
        signature: 'function helper(): void',
        pagerank: 0.5,
        usage_count: 0,
        line_start: 20,
      },
    ];
    const out = prepareRepoMapSymbols(rows);
    assert.equal(out.length, 1);
    assert.equal(out[0].file, 'src/core.ts');
    assert.ok(!out.some((s) => s.kind === 'property'));
    assert.ok(!out.some((s) => s.file.startsWith('test/')));
  });

  it('formatRepoMapSymbolLine adds kind tags and nesting indent', () => {
    const top = formatRepoMapSymbolLine({
      id: 'ws:MyService',
      kind: 'class',
      signature: 'class MyService',
    });
    assert.equal(top, '- [class] MyService');

    const nested = formatRepoMapSymbolLine({
      id: 'ws:MyService.run',
      kind: 'method',
      signature: 'method run(payload: unknown): Promise<void>',
    });
    assert.equal(nested, '  - [method] run(payload: unknown): Promise<void>');
  });

  it('isRepoMapTestPath recognizes test and spec files', () => {
    assert.equal(isRepoMapTestPath('src/foo.ts'), false);
    assert.equal(isRepoMapTestPath('test/brain/foo.test.mjs'), true);
    assert.equal(isRepoMapTestPath('src/foo.spec.ts'), true);
    assert.equal(isRepoMapTestPath('test/fixtures/sample.ts'), true);
  });

  it('rendered map prefers src symbols over test properties at same budget', () => {
    const rows = prepareRepoMapSymbols([
      {
        id: 'ws:dispatch',
        file: 'src/engine.ts',
        kind: 'function',
        signature: 'function dispatch(): void',
        pagerank: 0.3,
        usage_count: 1,
        line_start: 1,
      },
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `ws:test/huge.test.ts:case${i}.status`,
        file: 'test/huge.test.ts',
        kind: 'property',
        signature: 'property status',
        pagerank: 0.95,
        usage_count: 0,
        line_start: i + 1,
      })),
    ]);
    const map = renderRepoMap(rows, 120);
    assert.ok(map.text.includes('dispatch'));
    assert.ok(!map.text.includes('property status'));
  });

  it('injection profile drops nested constants, callbacks, and vitest setup paths', () => {
    const rows = [
      {
        id: 'ws:executeDay',
        file: 'server/simulation/tick.ts',
        kind: 'function',
        signature: 'function executeDay(): void',
        pagerank: 0.7,
        line_start: 12,
      },
      {
        id: 'ws:BaseAgent.decide.system',
        file: 'server/agents/base.ts',
        kind: 'constant',
        signature: 'constant system',
        pagerank: 0.99,
        line_start: 44,
      },
      {
        id: 'ws:BaseAgent.decide.retryFn.map() callback',
        file: 'server/agents/base.ts',
        kind: 'function',
        signature: 'function map() callback',
        pagerank: 0.98,
        line_start: 55,
      },
      {
        id: 'ws:setup',
        file: 'vitest.setup.ts',
        kind: 'function',
        signature: 'function setup()',
        pagerank: 0.97,
        line_start: 1,
      },
    ];
    const wide = prepareRepoMapSymbols(rows);
    const injection = prepareRepoMapSymbolsForInjection(rows);
    assert.equal(wide.length, 4);
    assert.equal(injection.length, 1);
    assert.equal(injection[0].id, 'ws:executeDay');
  });

  it('formatRepoMapInjectionLine includes path and line anchor', () => {
    const line = formatRepoMapInjectionLine({
      id: 'ws:SimulationOrchestrator',
      file: 'server/simulation/engine.ts',
      kind: 'class',
      signature: 'class SimulationOrchestrator',
      line_start: 42,
    });
    assert.equal(line, '- server/simulation/engine.ts:42 [class] SimulationOrchestrator');
  });

  it('isRepoMapInjectionTestPath covers vitest setup and vitest test files', () => {
    assert.equal(isRepoMapInjectionTestPath('vitest.setup.ts'), true);
    assert.equal(isRepoMapInjectionTestPath('server/llm/client.vitest.ts'), true);
    assert.equal(isRepoMapInjectionTestPath('test-ws.cjs'), true);
    assert.equal(isRepoMapTestPath('src/foo.ts'), false);
  });

  it('omits one-off script paths from injection maps but keeps them for the tool', () => {
    assert.equal(isRepoMapInjectionTestPath('scripts/gen-catalog.mjs'), true);
    assert.equal(isRepoMapInjectionTestPath('benchmarks/run.ts'), true);
    assert.equal(isRepoMapTestPath('scripts/gen-catalog.mjs'), false);
  });

  it('treats vendored, generated, and minified files as noise in every profile', () => {
    assert.equal(isRepoMapVendorPath('src/vendor/screenshot.js'), true);
    assert.equal(isRepoMapVendorPath('third_party/lib.ts'), true);
    assert.equal(isRepoMapVendorPath('src/lib/chart.min.js'), true);
    assert.equal(isRepoMapVendorPath('dist/app.js'), true);
    assert.equal(isRepoMapVendorPath('src/api/generated/schema.ts'), true);
    assert.equal(isRepoMapVendorPath('src/state/vendor-list.ts'), false);
    assert.equal(isRepoMapVendorPath('src/foo.ts'), false);
  });
});
