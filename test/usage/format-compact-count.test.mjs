import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatCompactCount } from '../../src/usage/format-compact-count.ts';

describe('formatCompactCount', () => {
  it('returns 0 for non-positive or non-finite values', () => {
    assert.equal(formatCompactCount(0), '0');
    assert.equal(formatCompactCount(-5), '0');
    assert.equal(formatCompactCount(Number.NaN), '0');
  });

  it('returns raw integers below 1k', () => {
    assert.equal(formatCompactCount(42), '42');
    assert.equal(formatCompactCount(999), '999');
  });

  it('uses k suffix between 1k and 1M', () => {
    assert.equal(formatCompactCount(1_500), '1.5k');
    assert.equal(formatCompactCount(12_345), '12k');
  });

  it('uses M suffix at millions', () => {
    assert.equal(formatCompactCount(1_300_000), '1.3M');
    assert.equal(formatCompactCount(2_000_000), '2M');
  });

  it('uses B suffix at billions', () => {
    assert.equal(formatCompactCount(1_250_000_000), '1.3B');
    assert.equal(formatCompactCount(5_000_000_000), '5B');
  });

  it('uses T suffix at trillions', () => {
    assert.equal(formatCompactCount(1_200_000_000_000), '1.2T');
    assert.equal(formatCompactCount(3_000_000_000_000), '3T');
  });
});
