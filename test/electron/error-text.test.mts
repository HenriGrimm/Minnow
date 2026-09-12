import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatUnknownError } from '../../electron/error-text.ts';

describe('formatUnknownError', () => {
  test('stringifies non-Error values', () => {
    assert.deepEqual(formatUnknownError('nope'), { message: 'nope' });
  });

  test('keeps a plain Error message and stack', () => {
    const err = new Error('missing module');
    const formatted = formatUnknownError(err);
    assert.equal(formatted.message, 'missing module');
    assert.match(formatted.stack ?? '', /missing module/);
    assert.equal(formatted.extra, undefined);
  });

  test('includes Node fetch cause code and message', () => {
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:9473');
    (cause as NodeJS.ErrnoException).code = 'ECONNREFUSED';
    const err = new TypeError('fetch failed', { cause });
    const formatted = formatUnknownError(err);
    assert.match(formatted.message, /fetch failed \(ECONNREFUSED\)/);
    assert.match(formatted.message, /Caused by: connect ECONNREFUSED 127\.0\.0\.1:9473/);
    assert.equal(formatted.extra?.causeCode, 'ECONNREFUSED');
    assert.equal(formatted.extra?.causeMessage, 'connect ECONNREFUSED 127.0.0.1:9473');
  });
});
