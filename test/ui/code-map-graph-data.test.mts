import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCodeMapGraph, codeMapGraphToMermaid } from '../../src/ui/brain/code-map-graph-data.ts';

test('repository graph connects directories, files, and clickable symbols', () => {
  const graph = buildCodeMapGraph({
    text: '', truncated: false, tokenEstimate: 20,
    entries: [
      { type: 'file', file: 'src/ui/code.ts', text: '## src/ui/code.ts' },
      { type: 'symbol', file: 'src/ui/code.ts', symbolId: 'code#open', text: '- [function] openCode(path)' },
      { type: 'symbol', file: 'src/ui/code.ts', symbolId: 'code#close', text: '- [function] closeCode()' },
      { type: 'file', file: 'src/chat/run.ts', text: '## src/chat/run.ts' },
      { type: 'symbol', file: 'src/chat/run.ts', symbolId: 'run#start', text: '- [function] startRun()' },
    ],
  });

  assert.equal(graph.totalFiles, 2);
  assert.equal(graph.totalSymbols, 3);
  assert.equal(graph.truncated, false);
  assert.deepEqual(graph.nodes.map((node) => node.id), [
    'dir:src/ui', 'file:src/ui/code.ts', 'sym:code#open', 'sym:code#close',
    'dir:src/chat', 'file:src/chat/run.ts', 'sym:run#start',
  ]);
  assert.equal(graph.edges.length, 5);
  assert.equal(graph.nodes.find((node) => node.symbolId === 'code#open')?.label, 'openCode');
  const mermaid = codeMapGraphToMermaid(graph);
  assert.match(mermaid, /^flowchart LR/);
  assert.match(mermaid, /n0 --> n1/);
  assert.match(mermaid, /n1 --> n2/);
});

test('repository graph bounds large maps and reports omitted nodes', () => {
  const entries = Array.from({ length: 90 }, (_, file) => [
    { type: 'file' as const, file: `src/f${file}.ts`, text: `## src/f${file}.ts` },
    ...Array.from({ length: 12 }, (_, symbol) => ({
      type: 'symbol' as const, file: `src/f${file}.ts`, symbolId: `${file}:${symbol}`, text: `- [function] fn${symbol}()`,
    })),
  ]).flat();
  const graph = buildCodeMapGraph({ text: '', truncated: false, tokenEstimate: 100, entries });
  assert.equal(graph.totalFiles, 90);
  assert.equal(graph.totalSymbols, 1080);
  assert.equal(graph.nodes.filter((node) => node.kind === 'page').length, 45);
  assert.equal(graph.nodes.filter((node) => node.kind === 'symbol').length, 150);
  assert.equal(graph.truncated, true);
  assert.ok((graph.hiddenCount ?? 0) > 0);
  assert.ok(graph.edges.every((edge) => graph.nodes.some((node) => node.id === edge.source)));
});
