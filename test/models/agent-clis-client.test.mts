import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  listAgentClis,
  setAgentCliEnabled,
  updateAgentCliSettings,
  verifyAgentCli,
} from '../../src/models/agent-clis.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('agent CLI client', () => {
  test('uses the fixed Models API routes and whitelisted JSON settings', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), init });
      const isList = String(input) === '/api/models/agent-clis';
      return new Response(JSON.stringify(isList ? { agentClis: [] } : { agentCli: { kind: 'claude' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await listAgentClis();
    await verifyAgentCli('claude');
    await setAgentCliEnabled('claude', true);
    await updateAgentCliSettings('claude', {
      binPath: null,
      maxConcurrent: 3,
      allowUtilityRoles: false,
      maxBudgetUsd: 1.25,
    });

    assert.deepEqual(requests.map((request) => request.url), [
      '/api/models/agent-clis',
      '/api/models/agent-clis/claude/verify',
      '/api/models/agent-clis/claude/enable',
      '/api/models/agent-clis/claude/settings',
    ]);
    assert.deepEqual(JSON.parse(String(requests[2].init?.body)), { enabled: true });
    assert.deepEqual(JSON.parse(String(requests[3].init?.body)), {
      binPath: null,
      maxConcurrent: 3,
      allowUtilityRoles: false,
      maxBudgetUsd: 1.25,
    });
  });

  test('surfaces the server error without exposing response internals', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'CLI is not installed' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
    await assert.rejects(() => verifyAgentCli('codex'), /CLI is not installed/);
  });
});
