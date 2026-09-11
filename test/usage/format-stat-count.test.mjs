import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatStatCount } from '../../src/usage/format-stat-count.ts';

describe('formatStatCount', () => {
  it('returns em-dash for missing values', () => {
    assert.deepEqual(formatStatCount(null), { display: '—', full: '' });
    assert.deepEqual(formatStatCount(undefined), { display: '—', full: '' });
    assert.deepEqual(formatStatCount(Number.NaN), { display: '—', full: '' });
  });

  it('uses locale commas below one million', () => {
    const result = formatStatCount(757_766);
    assert.equal(result.display, (757_766).toLocaleString());
    assert.equal(result.full, (757_766).toLocaleString());
  });

  it('compacts millions with one decimal when needed', () => {
    const result = formatStatCount(75_776_650);
    assert.equal(result.display, '75.8M');
    assert.equal(result.full, (75_776_650).toLocaleString());
  });

  it('drops trailing .0 for whole millions', () => {
    const result = formatStatCount(2_000_000);
    assert.equal(result.display, '2M');
    assert.equal(result.full, (2_000_000).toLocaleString());
  });

  it('compacts billions', () => {
    const result = formatStatCount(1_250_000_000);
    assert.equal(result.display, '1.3B');
    assert.equal(result.full, (1_250_000_000).toLocaleString());
  });

  it('compacts trillions', () => {
    const result = formatStatCount(1_200_000_000_000);
    assert.equal(result.display, '1.2T');
    assert.equal(result.full, (1_200_000_000_000).toLocaleString());
  });
});
