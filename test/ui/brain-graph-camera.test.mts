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

test('Brain redraws for graph controls and goes idle again after the graph settles', () => {
  const window = new Window();
  const pending = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  Object.assign(globalThis, {
    window,
    document: window.document,
    getComputedStyle: window.getComputedStyle.bind(window),
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    SVGElement: window.SVGElement,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      pending.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => pending.delete(id),
  });
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  canvas.getBoundingClientRect = () => new window.DOMRect(0, 0, 900, 620) as unknown as DOMRect;
  let paints = 0;
  Object.defineProperty(canvas, 'getContext', {
    value: () => new Proxy({
      clearRect: () => { paints++; },
      measureText: () => ({ width: 0 }),
    }, {
      get: (target, prop) => Reflect.get(target, prop) ?? (() => {}),
    }),
  });
  const flushFrame = () => {
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) callback(0);
  };
  let actionUpdates = 0;
  const graph = createForceGraph(canvas, {
    reducedMotion: true,
    onNodeActionsChange: () => { actionUpdates++; },
  });
  const id = 'page:project.md';

  try {
    graph.setData([{ id, kind: 'page', label: 'Project' }], []);
    flushFrame();
    assert.equal(paints, 1);
    assert.equal(pending.size, 0, 'settled graph schedules no idle frame');

    graph.selectNode(id);
    graph.focusNode(id);
    graph.setNodePinned(id, true);
    assert.equal(graph.isNodeFocused(id), true);
    assert.equal(graph.isNodePinned(id), true);
    assert.equal(actionUpdates, 3);
    assert.equal(pending.size, 1, 'changes before a frame are coalesced');
    flushFrame();
    assert.equal(paints, 2);
    assert.equal(pending.size, 0, 'selected and pinned graph also goes idle');

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    graph.setNodePinned(id, false);
    assert.equal(graph.isNodeFocused(id), false);
    assert.equal(graph.isNodePinned(id), false);
    flushFrame();
    assert.equal(paints, 3);
    graph.resize();
    graph.destroy();
    assert.equal(pending.size, 0, 'destroy cancels a pending redraw');
  } finally {
    graph.destroy();
    window.happyDOM.abort();
  }
});
