import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isUpstreamCatalogUnreachable, testProviderConnection } from '../../server/providers/proxy.js';

describe('isUpstreamCatalogUnreachable', () => {
  it('treats fetch failed and connection refused as unreachable', () => {
    assert.equal(isUpstreamCatalogUnreachable(new TypeError('fetch failed')), true);
    const refused = new Error('connect');
    refused.cause = { code: 'ECONNREFUSED' };
    assert.equal(isUpstreamCatalogUnreachable(refused), true);
  });

  it('does not treat a live upstream HTTP error as unreachable', () => {
    assert.equal(
      isUpstreamCatalogUnreachable(new Error('Upstream models HTTP 500: boom')),
      false,
    );
  });
});

describe('unsaved provider connection test', () => {
  it('uses the draft protocol, catalog path and authorization without looking up a saved provider', async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'fixture-model' }] }));
    const draft = { baseUrl: 'http://127.0.0.1:18784', apiKind: 'openai-v1', apiKey: 'fixture' };
    assert.deepEqual(await testProviderConnection(draft), { modelCount: 1 });
    const [url, request] = fetch.mock.calls[0].arguments;
    assert.equal(url, 'http://127.0.0.1:18784/v1/models');
    assert.equal(new Headers(request.headers).get('Authorization'), 'Bearer fixture');
  });

  it('points users to the API style and catalog path when the catalog is missing', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }));
    await assert.rejects(
      testProviderConnection({ baseUrl: 'http://127.0.0.1:18784', apiKind: 'openai-v1' }),
      /Check the API style and models path/,
    );
  });
});
