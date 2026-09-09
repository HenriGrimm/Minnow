/**
 * Detect CLI exit 2 is findings, not a crashed tool.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isImpeccableDetectFindingsResult,
  parseImpeccableDetectFindingsCount,
  stripImpeccableDetectExitBanner,
} from '../../src/lib/impeccable-detect-result.ts';

describe('isImpeccableDetectFindingsResult', () => {
  it('matches the Error: exited 2 banner the wrapper used to emit', () => {
    const raw =
      'Error: impeccable detect exited 2\n3 anti-patterns found.\nline 6: [design-system-color] red';
    assert.equal(isImpeccableDetectFindingsResult(raw), true);
    assert.equal(parseImpeccableDetectFindingsCount(raw), 3);
    assert.match(stripImpeccableDetectExitBanner(raw), /^3 anti-patterns found/);
  });

  it('matches a count-prefixed JSON payload', () => {
    assert.equal(isImpeccableDetectFindingsResult('2 anti-patterns found.\n[]'), true);
    assert.equal(parseImpeccableDetectFindingsCount('2 anti-patterns found.\n[{},{}]'), 2);
  });

  it('does not treat other detect failures as findings', () => {
    assert.equal(isImpeccableDetectFindingsResult('Error: impeccable detect exited 1\nboom'), false);
    assert.equal(isImpeccableDetectFindingsResult('Error: timed out after 60s'), false);
  });
});
