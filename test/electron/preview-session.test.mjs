import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { configurePreviewSession } from '../../electron/dist/preview-session.js';

describe('preview session headers', () => {
  test('preserves destination CSP and isolation headers by installing no rewrite hook', () => {
    let hooks = 0;
    configurePreviewSession({
      webRequest: {
        onHeadersReceived() { hooks += 1; },
      },
    });
    assert.equal(hooks, 0);
  });
});
