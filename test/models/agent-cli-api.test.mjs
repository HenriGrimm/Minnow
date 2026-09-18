import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { handleModelsRequest } from '../../server/models/routes.js';
import { handleProviderRequest } from '../../server/providers/routes.js';
import { getProviderRuntime } from '../../server/providers/store.js';
import { setTestHome, rmTestHome, httpRequest } from '../providers/test-helpers.js';

let homeDir;
let baseUrl;
let server;

before(async () => {
  homeDir = setTestHome(process.env, `minnow-agent-cli-api-${process.pid}`);
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    void handleModelsRequest(req, res, pathname).then((handled) => {
      if (handled) return;
      void handleProviderRequest(req, res, pathname).then((providerHandled) => {
        if (!providerHandled) {
          res.statusCode = 404;
          res.end('not found');
        }
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rmTestHome(homeDir);
});

describe('agent CLI model routes', () => {
  test('lists three passive statuses without creating provider rows', async () => {
    const response = await httpRequest(baseUrl, 'GET', '/api/models/agent-clis');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.agentClis.map((row) => row.kind), ['claude', 'codex', 'cursor']);
    assert.ok(response.json.agentClis.every((row) => row.enabled === false));
    const providerRoot = path.join(homeDir, 'providers');
    await assert.rejects(() => fs.access(providerRoot), { code: 'ENOENT' });
  });

  test('generic CRUD cannot spoof the kind or reserved IDs', async () => {
    const byKind = await httpRequest(baseUrl, 'POST', '/api/providers', {
      id: 'custom-agent-cli',
      label: 'Spoof',
      baseUrl: 'http://127.0.0.1:1',
      apiKind: 'agent-cli-v1',
    });
    assert.equal(byKind.status, 400);
    assert.match(byKind.json.error, /agent CLI providers/i);

    const byId = await httpRequest(baseUrl, 'POST', '/api/providers', {
      id: 'claude-code-cli',
      label: 'Spoof',
      baseUrl: 'http://127.0.0.1:1',
      apiKind: 'openai-v1',
    });
    assert.equal(byId.status, 400);
    assert.match(byId.json.error, /agent CLI providers/i);
  });

  test('dedicated settings create an inert disabled provider and encrypt cliToken', async () => {
    const response = await httpRequest(baseUrl, 'PUT', '/api/models/agent-clis/claude/settings', {
      binPath: process.execPath,
      allowUtilityRoles: false,
      maxConcurrent: 1,
      maxBudgetUsd: 2.5,
      cliToken: 'encrypted-cli-token-fixed',
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.provider.apiKind, 'agent-cli-v1');
    assert.equal(response.json.provider.baseUrl, '');
    assert.equal(response.json.provider.enabled, false);
    assert.equal(response.json.provider.hasCliToken, true);
    assert.equal(JSON.stringify(response.json).includes('encrypted-cli-token-fixed'), false);

    const runtime = await getProviderRuntime('claude-code-cli');
    assert.equal(runtime.profile.agentCli.sessionMode, 'replay');
    assert.equal(runtime.profile.agentCli.maxConcurrent, 1);
    assert.equal(runtime.secrets.cliToken, 'encrypted-cli-token-fixed');
    const raw = await fs.readFile(path.join(homeDir, 'providers', 'claude-code-cli', 'secrets.json'), 'utf8');
    assert.equal(raw.includes('encrypted-cli-token-fixed'), false);
  });

  test('enable route toggles only the matching reserved provider', async () => {
    const response = await httpRequest(baseUrl, 'POST', '/api/models/agent-clis/claude/enable', {
      enabled: true,
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.agentCli.enabled, true);
    assert.equal(response.json.provider.id, 'claude-code-cli');
  });

  test('serves the static catalog and capability matrix without an HTTP upstream', async () => {
    const models = await httpRequest(
      baseUrl,
      'GET',
      '/api/providers/claude-code-cli/models',
    );
    assert.equal(models.status, 200);
    assert.deepEqual(models.json.data.map((row) => row.id), ['sonnet', 'opus', 'haiku']);
    assert.ok(models.json.data.every((row) => row.api === 'agent-cli-v1'));

    const capabilities = await httpRequest(
      baseUrl,
      'POST',
      '/api/providers/claude-code-cli/probe-capabilities',
      {},
    );
    assert.equal(capabilities.status, 200);
    assert.equal(capabilities.json.apiKind, 'agent-cli-v1');
    assert.equal(capabilities.json.models.sonnet.vision, true);
    assert.equal(capabilities.json.models.sonnet.tools, true);
    assert.equal(capabilities.json.models.haiku.reasoning, false);
  });

  test('generic updates and secret writes cannot mutate reserved providers', async () => {
    const update = await httpRequest(baseUrl, 'PUT', '/api/providers/claude-code-cli', {
      apiKind: 'openai-v1',
      baseUrl: 'http://127.0.0.1:9999',
    });
    assert.equal(update.status, 400);
    const secrets = await httpRequest(
      baseUrl,
      'PUT',
      '/api/providers/claude-code-cli/secrets',
      { apiKey: 'spoofed-key' },
    );
    assert.equal(secrets.status, 400);
    const runtime = await getProviderRuntime('claude-code-cli');
    assert.equal(runtime.profile.apiKind, 'agent-cli-v1');
    assert.equal(runtime.profile.baseUrl, '');
    assert.equal(runtime.secrets.apiKey, '');
  });

  test('settings reject permission bypasses, extra args, and concurrency above sixteen', async () => {
    for (const body of [
      { extraArgs: ['--dangerously-skip-permissions'] },
      { permissionMode: 'bypassPermissions' },
      { maxConcurrent: 17 },
    ]) {
      const response = await httpRequest(
        baseUrl,
        'PUT',
        '/api/models/agent-clis/codex/settings',
        body,
      );
      assert.equal(response.status, 400);
    }
  });
});
