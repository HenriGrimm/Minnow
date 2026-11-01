/**
 * Floating placement math: preferred side, flip, clamp.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { computeFloatingPosition, type RectLike } from '../../../src/ui/components/position';

const viewport = { width: 1000, height: 800 };
const size = { width: 200, height: 100 };

function rect(left: number, top: number, width: number, height: number): RectLike {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

describe('computeFloatingPosition', () => {
  test('surface placement can preserve fractional anchor coordinates', () => {
    const anchor = rect(100.25, 100.5, 80, 30);
    const pos = computeFloatingPosition(anchor, size, viewport, { offset: 4, round: false });
    assert.deepEqual(pos, { left: 100.25, top: 134.5, placement: 'bottom-start' });
    assert.equal(computeFloatingPosition(anchor, size, viewport).left, 100);
  });
  test('bottom-start sits under the anchor at the offset, aligned to its left edge', () => {
    const pos = computeFloatingPosition(rect(100, 100, 80, 30), size, viewport, { placement: 'bottom-start', offset: 4 });
    assert.deepEqual(pos, { left: 100, top: 134, placement: 'bottom-start' });
  });

  test('bottom-end aligns right edges and top centres when unaligned', () => {
    const end = computeFloatingPosition(rect(400, 100, 80, 30), size, viewport, { placement: 'bottom-end', offset: 0 });
    assert.equal(end.left, 280);
    const centred = computeFloatingPosition(rect(400, 300, 80, 30), size, viewport, { placement: 'top', offset: 0 });
    assert.equal(centred.left, 340);
    assert.equal(centred.top, 200);
    assert.equal(centred.placement, 'top');
  });

  test('flips to the top when the bottom would clip', () => {
    const anchor = rect(100, viewport.height - 40, 80, 30);
    const pos = computeFloatingPosition(anchor, size, viewport, { placement: 'bottom-start', offset: 4 });
    assert.equal(pos.placement, 'top-start');
    assert.equal(pos.top, anchor.top - 4 - size.height);
  });

  test('keeps the preferred side when neither side fits, then clamps', () => {
    const tall = { width: 200, height: 790 };
    const pos = computeFloatingPosition(rect(100, 400, 80, 30), tall, viewport, { placement: 'bottom-start', edgeGap: 8 });
    assert.equal(pos.placement, 'bottom-start');
    assert.equal(pos.top, 8);
  });

  test('clamps into the viewport on both horizontal edges', () => {
    const right = computeFloatingPosition(rect(950, 100, 40, 30), size, viewport, { placement: 'bottom-start', edgeGap: 8 });
    assert.equal(right.left, viewport.width - size.width - 8);
    const left = computeFloatingPosition(rect(2, 100, 40, 30), size, viewport, { placement: 'bottom-end', edgeGap: 8 });
    assert.equal(left.left, 8);
  });

  test('right flips to left near the right edge and centres vertically', () => {
    const pos = computeFloatingPosition(rect(900, 300, 60, 40), size, viewport, { placement: 'right', offset: 4 });
    assert.equal(pos.placement, 'left');
    assert.equal(pos.left, 900 - 4 - size.width);
    assert.equal(pos.top, 270);
  });
});
