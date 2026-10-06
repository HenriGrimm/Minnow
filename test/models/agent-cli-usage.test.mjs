import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { normalizeCodexUsage, normalizeClaudeUsage } from '../../server/models/cli-usage-normalize.js';
import { CliUsageError, readClaudeUsageCredentials, readClaudeAccountUsage } from '../../server/models/claude-cli-usage.js';
import { readCodexAccountUsage } from '../../server/models/codex-cli-usage.js';
import { createAgentCliUsageService } from '../../server/models/agent-cli-usage.js';

const data = { plan: 'pro', windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 29,
  windowMinutes: 10080, resetsAt: '2027-01-01T00:00:00.000Z' }] };

test('Codex normalizes dynamic windows and prefers multiple buckets without duplicating the legacy bucket', () => {
  const result = normalizeCodexUsage({ rateLimits: { primary: { usedPercent: 99 }, credits: { unlimited: false, balance: '0', token: 'secret' } },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 29, windowDurationMins: 10080, resetsAt: 1791588043 }, secondary: null },
      other: { limitName: 'Other models', primary: { usedPercent: 42, windowDurationMins: 15, resetsAt: null } } } }, { planType: 'pro', email: 'private@example.com' });
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[0].label, 'Weekly');
  assert.equal(result.windows[0].usedPercent, 29);
  assert.equal(result.windows[0].resetsAt, new Date(1791588043000).toISOString());
  assert.equal(result.windows[1].label, 'Other models · 15-minute');
  assert.equal(result.windows[1].resetsAt, null);
  assert.deepEqual(result.credits, { unlimited: false, balance: '0' });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('normalizers distinguish valid zero usage from absent or malformed measurements', () => {
  assert.equal(normalizeCodexUsage({ rateLimits: { primary: { usedPercent: 0 } } }).windows[0].usedPercent, 0);
  assert.deepEqual(normalizeCodexUsage({ rateLimits: { primary: { usedPercent: '0' }, secondary: { usedPercent: -1 } } }).windows, []);
  const result = normalizeClaudeUsage({ five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 33, resets_at: '2026-10-07T20:00:00+00:00' },
    seven_day_opus: null, extra_usage: { utilization: 50 }, private_future_field: { utilization: 80 }, seven_day_sonnet: { utilization: 105, resets_at: 'bad' } }, 'max');
  assert.deepEqual(result.windows.map(row => row.usedPercent), [0, 33, 105]);
  assert.equal(result.windows[1].resetsAt, '2026-10-07T20:00:00.000Z');
  assert.equal(result.windows[2].resetsAt, null);
});

test('cache coalesces reads, respects manual refresh cooldown and backoff, and retains labeled last-known data', async () => {
  let time = Date.parse('2026-10-03T00:00:00Z');
  let calls = 0;
  let failure = false;
  const service = createAgentCliUsageService({ now: () => time, loadCredentials: async () => ({ key: 'account-1' }),
    readUsage: async () => { calls++; if (failure) throw new CliUsageError('error', 'Temporarily limited', 180000); return data; } });
  const [a, b] = await Promise.all([service.get('codex'), service.get('codex')]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  await service.get('codex', { refresh: true });
  assert.equal(calls, 1);
  time += 11000;
  await service.get('codex', { refresh: true });
  assert.equal(calls, 2);
  time += 61000;
  failure = true;
  const stale = await service.get('codex');
  assert.equal(stale.status, 'stale');
  assert.equal(stale.fetchedAt, new Date(time - 61000).toISOString());
  assert.deepEqual(stale.windows, data.windows);
  assert.equal(Date.parse(stale.retryAt), time + 180000);
  time += 120000;
  await service.get('codex', { refresh: true });
  assert.equal(calls, 3, 'manual refresh cannot bypass provider backoff');
  time += 3700000;
  const expired = await service.get('codex');
  assert.equal(expired.status, 'error');
  assert.equal(expired.fetchedAt, null);
  assert.deepEqual(expired.windows, []);
});

test('native credential fingerprints invalidate snapshots while guarded Codex token refresh preserves the same account', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-usage-identity-test-'));
  try {
    const file = path.join(root, 'auth.json');
    await fs.writeFile(file, '{"tokens":{"account_id":"account-a","access_token":"first"}}');
    let calls = 0;
    const service = createAgentCliUsageService({ readUsage: async () => {
      calls++;
      if (calls === 1) await fs.writeFile(file, '{"tokens":{"account_id":"account-a","access_token":"refreshed"}}');
      return data;
    } });
    const options = { env: { CODEX_HOME: root } };
    assert.equal((await service.get('codex', options)).status, 'ready');
    await service.get('codex', options);
    assert.equal(calls, 1, 'same account token refresh is cached under the refreshed credentials');
    await fs.writeFile(file, '{"tokens":{"account_id":"account-b","access_token":"other"}}');
    await service.get('codex', options);
    assert.equal(calls, 2, 'a different account never receives the previous snapshot');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('account changes cannot reuse or paint another login snapshot, and sign-out clears old measurements', async () => {
  let time = 1000000;
  let key = 'first';
  let mode = 'ready';
  const service = createAgentCliUsageService({ now: () => time, loadCredentials: async () => ({ key }),
    readUsage: async () => {
      if (mode === 'switch') { key = 'second'; return data; }
      if (mode === 'failed-switch') { key = 'third'; throw new Error('request failed'); }
      if (mode === 'signed-out') throw new CliUsageError('signed-out', 'Sign in again');
      if (mode === 'secret-error') throw new Error('token-secret-must-not-leak');
      return data;
    } });
  await service.get('claude');
  time += 61000;
  mode = 'switch';
  assert.equal((await service.get('claude')).status, 'unavailable');
  mode = 'secret-error';
  const failed = await service.get('claude');
  assert.deepEqual(failed.windows, []);
  assert.equal(JSON.stringify(failed).includes('token-secret'), false);
  time += 61000;
  mode = 'ready';
  await service.get('claude');
  time += 61000;
  mode = 'signed-out';
  const signedOut = await service.get('claude');
  assert.equal(signedOut.status, 'signed-out');
  assert.deepEqual(signedOut.windows, []);
  time += 61000;
  mode = 'ready';
  await service.get('claude');
  time += 61000;
  mode = 'failed-switch';
  const changed = await service.get('claude');
  assert.equal(changed.status, 'unavailable');
  assert.deepEqual(changed.windows, []);
  assert.equal((await service.get('cursor')).status, 'unsupported');
});

test('Claude credentials follow inference auth configuration and expired logins never trigger refresh', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-claude-usage-test-'));
  try {
    await fs.mkdir(path.join(root, '.claude'));
    const file = path.join(root, '.claude', '.credentials.json');
    await fs.writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: 'private-token', expiresAt: Date.now() + 3600000, subscriptionType: 'max' } }));
    const options = { env: {}, homeDir: root, platform: 'win32' };
    assert.deepEqual(await readClaudeUsageCredentials(options), { token: 'private-token', plan: 'max' });
    assert.equal((await readClaudeUsageCredentials({ ...options, env: { CLAUDE_CODE_OAUTH_TOKEN: 'env-token' } })).token, 'env-token');
    for (const override of [{ cliToken: 'api-key' }, { env: { ANTHROPIC_API_KEY: 'api-key' } }, { env: { ANTHROPIC_BASE_URL: 'http://localhost' } }]) {
      await assert.rejects(readClaudeUsageCredentials({ ...options, ...override }), error => error.status === 'unsupported');
    }
    await fs.writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: 'expired-token', expiresAt: 1 } }));
    await assert.rejects(readClaudeUsageCredentials(options), error => error.status === 'signed-out' && !error.message.includes('expired-token'));
    const keychain = await readClaudeUsageCredentials({ env: {}, homeDir: path.join(root, 'missing'), platform: 'darwin', runProcess: async (command, args) => {
      assert.equal(command, '/usr/bin/security');
      assert.deepEqual(args, ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
      return { code: 0, stdout: '{"claudeAiOauth":{"accessToken":"keychain-token"}}' };
    } });
    assert.equal(keychain.token, 'keychain-token');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Claude endpoint uses bounded authenticated GET, never follows redirects, and redacts provider errors', async () => {
  const login = { token: 'secret-token', plan: 'max' };
  const result = await readClaudeAccountUsage(login, { fetch: async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(init.headers.Authorization, 'Bearer secret-token');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    return new Response('{"seven_day":{"utilization":33,"resets_at":null}}');
  } });
  assert.equal(result.windows[0].usedPercent, 33);
  for (const [status, expected] of [[401, 'signed-out'], [403, 'signed-out'], [429, 'error'], [500, 'error']]) {
    await assert.rejects(readClaudeAccountUsage(login, { fetch: async () => new Response('secret-token', { status, headers: { 'Retry-After': '120' } }) }),
      error => error.status === expected && !error.message.includes('secret-token'));
  }
  await assert.rejects(readClaudeAccountUsage(login, { fetch: async () => new Response('{}') }), error => error.status === 'unavailable');
  await assert.rejects(readClaudeAccountUsage(login, { fetch: async () => new Response('x'.repeat(256 * 1024 + 1)) }), /size limit/);
});

test('Codex usage only initializes and reads account RPCs in a private home, syncs refreshed login and cleans up on failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-codex-usage-test-'));
  try {
    const authPath = path.join(root, 'auth.json');
    await fs.writeFile(authPath, '{"tokens":"original"}');
    let privateHome;
    let closed = false;
    const calls = [];
    const options = { env: { CODEX_HOME: root }, resolveBin: async () => ({ command: 'fake-codex', argsPrefix: [] }),
      createRpc: invocation => {
        privateHome = invocation.cwd;
        assert.notEqual(privateHome, root);
        assert.equal(invocation.env.CODEX_HOME, privateHome);
        return { initialize: async () => calls.push('initialize'), request: async method => {
          calls.push(method);
          assert.equal(await fs.readFile(path.join(privateHome, 'auth.json'), 'utf8'), '{"tokens":"original"}');
          if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } };
          await fs.writeFile(path.join(privateHome, 'auth.json'), '{"tokens":"refreshed"}');
          return { rateLimits: { primary: { usedPercent: 29, windowDurationMins: 10080 } } };
        }, close: async () => { closed = true; } };
      } };
    const result = await readCodexAccountUsage(options);
    assert.equal(result.windows[0].usedPercent, 29);
    assert.deepEqual(calls, ['initialize', 'account/read', 'account/rateLimits/read']);
    assert.equal(closed, true);
    assert.equal(await fs.readFile(authPath, 'utf8'), '{"tokens":"refreshed"}');
    await assert.rejects(fs.access(privateHome), { code: 'ENOENT' });
    closed = false;
    await assert.rejects(readCodexAccountUsage({ ...options, createRpc: invocation => {
      privateHome = invocation.cwd;
      return { initialize: async () => {}, request: async () => ({ account: { type: 'apiKey' } }), close: async () => { closed = true; } };
    } }), error => error.status === 'unsupported');
    assert.equal(closed, true);
    await assert.rejects(fs.access(privateHome), { code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
