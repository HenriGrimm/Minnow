/**
 * probeLocalProviders() must request Ollama's models path without doubling /v1
 * (regression for MIN-61: http://localhost:11434/v1 + /v1/models -> /v1/v1/models).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { probeLocalProviders } from '../../src/onboarding/provider-probe.ts';

describe('local provider probe URLs', () => {
  test('probes local providers without double /v1 in the URL', async () => {
    const requestedUrls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      requestedUrls.push(String(url));
      return { ok: true };
    };

    let results;
    try {
      results = await probeLocalProviders();
    } finally {
      globalThis.fetch = originalFetch;
    }

    const expected = [
      'http://localhost:1234/api/v0/models',
      'http://localhost:11434/v1/models',
      'http://127.0.0.1:8085/v1/models',
    ];
    assert.deepEqual([...requestedUrls].sort(), [...expected].sort());

    for (const url of requestedUrls) {
      assert.equal(url.includes('/v1/v1/'), false, `unexpected double /v1 in ${url}`);
    }

    for (const result of results) {
      assert.equal(result.reachable, true);
    }
  });
});
