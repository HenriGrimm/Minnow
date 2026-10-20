import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountUsageService } from '../../server/providers/account-usage.js';
import { setTestHome, rmTestHome, createProviderTestServer, httpRequest } from './test-helpers.js';

const balance = { currency: 'USD', total_balance: '12.50', granted_balance: '2.50', topped_up_balance: '10.00' };
function setup(options = {}) {
  let runtime = { profile: { baseUrl: 'https://api.deepseek.com/v1', label: 'Anything' }, secrets: { apiKey: 'secret' }, headers: { Authorization: 'Bearer secret' } };
  let time = 0;
  let home = 'home-a';
  const calls = [];
  const service = createAccountUsageService({
    getRuntime: async () => runtime,
    now: () => time,
    getHome: () => home,
    fetchImpl: async (...args) => { calls.push(args); return Response.json({ balance_infos: [balance] }); },
    ...options,
  });
  return { service, calls, setRuntime: (value) => { runtime = value; }, runtime: () => runtime, tick: (value) => { time = value; }, home: (value) => { home = value; } };
}

test('exact read-only request, contract, coalescing and 60 second cache', async () => {
  const ctx = setup();
  const results = await Promise.all([ctx.service('one'), ctx.service('one')]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].status, 'available');
  assert.equal(results[0].checkedAt, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(results[0].metrics[0], { label: 'Total balance', remaining: 12.5, unit: 'USD' });
  assert.equal(ctx.calls.length, 1);
  const [url, init] = ctx.calls[0];
  assert.equal(url, 'https://api.deepseek.com/user/balance');
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, 'Bearer secret');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.body, undefined);
  ctx.tick(59_999); await ctx.service('one'); assert.equal(ctx.calls.length, 1);
  ctx.tick(60_000); await ctx.service('one'); assert.equal(ctx.calls.length, 2);
});

test('credential, configuration and home identities invalidate cache', async () => {
  const ctx = setup();
  await ctx.service('one');
  ctx.setRuntime({ ...ctx.runtime(), secrets: { apiKey: 'new' }, headers: { Authorization: 'Bearer new' } });
  await ctx.service('one');
  assert.equal(ctx.calls[1][1].headers.Authorization, 'Bearer new');
  ctx.setRuntime({ ...ctx.runtime(), profile: { ...ctx.runtime().profile, label: 'Changed' } });
  await ctx.service('one');
  ctx.home('home-b'); await ctx.service('one');
  assert.equal(ctx.calls.length, 4);
});

test('unsupported origins and CLI never request; label does not establish trust', async () => {
  for (const baseUrl of ['https://api.deepseek.com.evil.test', 'http://api.deepseek.com', 'https://api.deepseek.com:444', 'https://user:pass@api.deepseek.com', 'https://example.com', '']) {
    const ctx = setup();
    ctx.setRuntime({ ...ctx.runtime(), profile: { baseUrl, label: 'DeepSeek' } });
    assert.equal((await ctx.service('one')).status, 'unsupported');
    assert.equal(ctx.calls.length, 0);
  }
  const ctx = setup();
  ctx.setRuntime({ ...ctx.runtime(), profile: { baseUrl: 'https://api.deepseek.com', apiKind: 'agent-cli-v1' } });
  assert.equal((await ctx.service('one')).status, 'unsupported');
  assert.equal(ctx.calls.length, 0);
});

test('upstream errors, redirects, timeout and oversized responses are sanitized', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('secret upstream details'); },
    async () => new Response('secret', { status: 401 }),
    async () => new Response('', { status: 302, headers: { location: 'https://evil.test' } }),
    async () => new Response('x'.repeat(65537)),
    async () => new Response('not json'),
    async () => new Promise(() => {}),
  ]) {
    const ctx = setup({ fetchImpl, timeoutMs: 10 });
    const result = await ctx.service('one');
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.metrics, []);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('strict balance validation rejects missing, blank, null, nonfinite and unsupported units', async () => {
  for (const value of [null, '', ' ', 'Infinity', 'NaN', '0x10', '1e3', 0, '9'.repeat(400), undefined]) {
    const ctx = setup({ fetchImpl: async () => Response.json({ balance_infos: [{ ...balance, total_balance: value }] }) });
    assert.equal((await ctx.service('one')).status, 'unavailable', String(value));
  }
  for (const payload of [{}, { balance_infos: [] }, { balance_infos: [null] }, { balance_infos: [{ ...balance, currency: 'EUR' }] }]) {
    assert.equal((await setup({ fetchImpl: async () => Response.json(payload) }).service('one')).status, 'unavailable');
  }
  const zero = setup({ fetchImpl: async () => Response.json({ balance_infos: [{ ...balance, currency: 'CNY', total_balance: '0.00' }] }) });
  assert.equal((await zero.service('one')).metrics[0].remaining, 0);
});

test('runtime failures and missing credentials are unavailable without network', async () => {
  assert.equal((await setup({ getRuntime: async () => { throw new Error('secret'); } }).service('one')).status, 'unavailable');
  const ctx = setup();
  ctx.setRuntime({ ...ctx.runtime(), headers: {} });
  assert.equal((await ctx.service('one')).status, 'unavailable');
  assert.equal(ctx.calls.length, 0);
});

test('HTTP route validates ids, missing providers, GET-only and no-store', async () => {
  const home = setTestHome(process.env, 'minnow-account-usage');
  const server = createProviderTestServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const available = await fetch(base + '/api/providers/lm-studio-local/usage');
    assert.equal(available.status, 200);
    assert.equal(available.headers.get('cache-control'), 'no-store');
    assert.equal((await available.json()).status, 'unsupported');
    assert.equal((await httpRequest(base, 'GET', '/api/providers/no-such-provider/usage')).status, 404);
    assert.equal((await httpRequest(base, 'GET', '/api/providers/bad%20id/usage')).status, 400);
    assert.equal((await httpRequest(base, 'POST', '/api/providers/lm-studio-local/usage')).status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rmTestHome(home);
  }
});

test('Go uses encrypted runtime auth for its read-only quota route and never generations', async () => {
  const calls = [];
  const ctx = setup({ fetchImpl: async (...args) => {
    calls.push(args);
    return Response.json({ rollingUsage: { usagePercent: 25, resetInSec: 3600 },
      weeklyUsage: { usagePercent: 40, resetInSec: 86400 },
      monthlyUsage: { usagePercent: 10, resetInSec: 90000 } });
  } });
  ctx.setRuntime({ ...ctx.runtime(), profile: { baseUrl: 'https://opencode.ai/zen/go' } });
  const result = await ctx.service('go');
  assert.equal(result.status, 'available');
  assert.equal(result.metrics.length, 3);
  assert.equal(result.metrics[0].remaining, 75);
  assert.equal(result.metrics[0].resetsAt, '1970-01-01T01:00:00.000Z');
  assert.equal(calls[0][0], 'https://opencode.ai/zen/go/v1/usage');
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].body, undefined);
  assert.equal(calls[0][1].headers.Authorization, 'Bearer secret');
  assert.match(calls[0][1].headers['User-Agent'], /^Minnow\//);
  assert.equal(calls[0][1].redirect, 'error');
  for (const baseUrl of ['https://opencode.ai.evil.test/zen/go', 'http://opencode.ai/zen/go',
    'https://opencode.ai/zen', 'https://user:pass@opencode.ai/zen/go']) {
    ctx.setRuntime({ ...ctx.runtime(), profile: { baseUrl } });
    assert.equal((await ctx.service('go')).status, 'unsupported');
  }
  assert.equal(calls.length, 1);
});

test('Go malformed or absent quota stays unavailable rather than inventing allowance', async () => {
  const ctx = setup({ fetchImpl: async () => Response.json({ rollingUsage: { usagePercent: null } }) });
  ctx.setRuntime({ ...ctx.runtime(), profile: { baseUrl: 'https://opencode.ai/inference/go/openai' } });
  assert.deepEqual((await ctx.service('go')).metrics, []);
  assert.equal((await ctx.service('go')).status, 'unavailable');
});

test('a credential change during an account read cannot paint the previous balance', async () => {
  let finish;
  const ctx = setup({ fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  const reading = ctx.service('one');
  await new Promise(resolve => setTimeout(resolve, 0));
  ctx.setRuntime({ ...ctx.runtime(), secrets: { apiKey: 'different' } });
  finish(Response.json({ balance_infos: [balance] }));
  assert.equal((await reading).status, 'unavailable');
  assert.deepEqual((await reading).metrics, []);
});
