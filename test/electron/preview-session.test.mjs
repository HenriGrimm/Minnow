import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { configurePreviewSession } from '../../electron/dist/preview-session.js';

describe('preview session headers', () => {
  test('does not install a hook that strips CSP or cross-origin isolation headers', () => {
    let hooks = 0;
    configurePreviewSession({
      webRequest: {
        onHeadersReceived() { hooks += 1; },
      },
    });
    assert.equal(hooks, 0);
  });
});
