import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { createForceGraph } from '../../src/ui/brain/graph/force-graph.ts';
import type { GraphNode } from '../../src/ui/brain/graph/types.ts';

test('Brain fits a graph rebuilt out of view and preserves manual zoom across a resize', () => {
  const window = new Window();
  Object.assign(globalThis, {
    window,
    document: window.document,
    getComputedStyle: window.getComputedStyle.bind(window),
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    SVGElement: window.SVGElement,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
  });
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  let width = 0;
  let height = 0;
  canvas.getBoundingClientRect = () => new window.DOMRect(0, 0, width, height) as unknown as DOMRect;
  Object.defineProperty(canvas, 'getContext', { value: () => ({ setTransform() {} }) });
  const graph = createForceGraph(canvas, { reducedMotion: true });
  const nodes: GraphNode[] = [
    { id: 'page:first', kind: 'page', label: 'First' },
    { id: 'tag:shared', kind: 'tag', label: 'Shared' },
  ];

  try {
    graph.setData(nodes, [{ id: 'edge', kind: 'tag', source: nodes[0].id, target: nodes[1].id }]);
    assert.equal(graph.getTransform().k, 1);

    width = 900;
    height = 620;
    graph.setViewportInsets({ right: 320, top: 48 });
    graph.resize();
    const firstFit = graph.getTransform();
    assert.notEqual(firstFit.k, 1);
    assert.ok(firstFit.x > 260 && firstFit.x < 320, 'the fit uses the canvas left of the reader');

    graph.zoomBy(0.8);
    const zoomed = graph.getTransform();
    width = 1100;
    graph.resize();
    const expanded = graph.getTransform();
    assert.equal(expanded.k, zoomed.k);
    assert.equal(expanded.x, zoomed.x + 100);
    assert.equal(expanded.y, zoomed.y);

    graph.setViewportInsets({ right: 0, bottom: 320 });
    const sheet = graph.getTransform();
    assert.equal(sheet.k, zoomed.k);
    assert.equal(sheet.x, expanded.x + 160);
    assert.equal(sheet.y, expanded.y - 160);
  } finally {
    graph.destroy();
    window.happyDOM.abort();
  }
});
