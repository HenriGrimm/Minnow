import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MINNOW_MARK_PIXEL,
  MINNOW_MARK_ROWS,
  MINNOW_MARK_VECTOR,
  minnowMarkCells,
  minnowMarkPath,
} from '../../src/lib/minnow-mark.mjs';

describe('minnow mark', () => {
  it('is a 7 × 5 grid with 23 cells and the eye left empty', () => {
    assert.equal(MINNOW_MARK_ROWS.length, 5);
    for (const row of MINNOW_MARK_ROWS) assert.equal(row.length, 7);
    assert.equal(minnowMarkCells().length, 23);
    assert.equal(MINNOW_MARK_ROWS[1][5], '.');
  });

  it('sets the tail as a > chevron', () => {
    const tail = minnowMarkCells().filter(({ c }) => c < 2);
    assert.deepEqual(tail, [{ r: 1, c: 0 }, { r: 2, c: 1 }, { r: 3, c: 0 }]);
  });

  it('keeps the 16px master on whole pixels inside its box', () => {
    const nums = MINNOW_MARK_PIXEL.d.match(/-?[\d.]+/g).map(Number);
    for (const n of nums) assert.ok(Number.isInteger(n), `${n} is not a whole pixel`);
    const moves = [...MINNOW_MARK_PIXEL.d.matchAll(/M(\d+) (\d+)/g)].map((m) => [+m[1], +m[2]]);
    for (const [x, y] of moves) {
      assert.ok(x >= 0 && x + 2 <= 16 && y >= 0 && y + 2 <= 16);
    }
  });

  it('draws one subpath per cell', () => {
    assert.equal((MINNOW_MARK_VECTOR.d.match(/M/g) ?? []).length, 23);
    assert.equal((minnowMarkPath({ cell: 3, step: 4 }).match(/z/g) ?? []).length, 23);
  });
});
