import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isMinnowPreviewResponseUrl, sanitizeEmbedBlockingHeaders } from '../../electron/dist/preview-session.js';

describe('preview session headers', () => {
  test('removes X-Frame-Options', () => {
    const out = sanitizeEmbedBlockingHeaders({
      'X-Frame-Options': ['DENY'],
      'Content-Type': ['text/html'],
    });
    assert.equal(out['X-Frame-Options'], undefined);
    assert.equal(out['Content-Type']?.[0], 'text/html');
  });

  test('removes entire CSP when present', () => {
    const out = sanitizeEmbedBlockingHeaders({
      'content-security-policy': [
        "default-src 'self'; frame-ancestors https://example.com; script-src 'unsafe-inline'",
      ],
    });
    assert.equal(out['content-security-policy'], undefined);
  });

  test('removes cross-origin embedder policy', () => {
    const out = sanitizeEmbedBlockingHeaders({
      'cross-origin-embedder-policy': ['require-corp'],
    });
    assert.equal(out['cross-origin-embedder-policy'], undefined);
  });

  test('preserves CSP and isolation headers for Minnow preview responses', () => {
    const headers = {
      'Content-Security-Policy': ["sandbox; default-src 'none'"],
      'Cross-Origin-Resource-Policy': ['same-origin'],
    };
    assert.deepEqual(sanitizeEmbedBlockingHeaders(headers, true), headers);
    assert.equal(isMinnowPreviewResponseUrl(`http://127.0.0.1:9474/p/${'a'.repeat(64)}/api/preview/file/index.html`), true);
    assert.equal(isMinnowPreviewResponseUrl('https://example.com/page'), false);
  });
});
