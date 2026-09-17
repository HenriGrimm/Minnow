/**
 * Provider host locality helpers (local loopback vs remote cloud APIs).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('provider-host', () => {
  test('LAN template controls survive both sanitizers without marking LAN inference on-device', async () => {
    const client = await import('../../src/providers/provider-host.ts');
    const server = await import('../../server/providers/provider-host.js');
    for (const baseUrl of ['http://192.168.4.168:5678', 'http://10.0.0.2:1234', 'http://172.16.0.2', 'http://172.31.255.254', 'http://macmini.local:5678', 'http://[fd12::1]:8000']) {
      const provider = { id: 'custom-lan', baseUrl };
      assert.equal(client.providerSupportsChatTemplateKwargs(provider), true, baseUrl);
      assert.equal(server.providerSupportsChatTemplateKwargs(provider), true, baseUrl);
      assert.equal(client.isLocalProvider(provider), false, 'LAN is not on-device');
    }
    for (const baseUrl of ['https://api.openai.com', 'https://opencode.ai/zen/go', 'http://172.15.0.2', 'http://172.32.0.2', 'http://192.169.0.2', 'http://192.168.1.2.example.com']) {
      assert.equal(client.providerSupportsChatTemplateKwargs({ id: 'cloud', baseUrl }), false, baseUrl);
      assert.equal(server.providerSupportsChatTemplateKwargs({ id: 'cloud', baseUrl }), false, baseUrl);
    }
  });
  test('isLocalProviderHostname recognizes loopback hosts', async () => {
    const { isLocalProviderHostname } = await import('../../src/providers/provider-host.ts');
    assert.equal(isLocalProviderHostname('localhost'), true);
    assert.equal(isLocalProviderHostname('127.0.0.1'), true);
    assert.equal(isLocalProviderHostname('::1'), true);
    assert.equal(isLocalProviderHostname('api.openai.com'), false);
  });

  test('isLocalProviderBaseUrl parses provider URLs', async () => {
    const { isLocalProviderBaseUrl } = await import('../../src/providers/provider-host.ts');
    assert.equal(isLocalProviderBaseUrl('http://localhost:1234'), true);
    assert.equal(isLocalProviderBaseUrl('http://127.0.0.1:11434/v1'), true);
    assert.equal(isLocalProviderBaseUrl('https://api.anthropic.com'), false);
  });

  test('isKnownLocalProviderId recognizes built-in local provider ids', async () => {
    const { isKnownLocalProviderId } = await import('../../src/providers/provider-host.ts');
    assert.equal(isKnownLocalProviderId('lm-studio-local'), true);
    assert.equal(isKnownLocalProviderId('vite-fallback'), true);
    assert.equal(isKnownLocalProviderId('openrouter'), false);
  });
});
