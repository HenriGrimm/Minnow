import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeExternalConnection } from '../../server/system/external-connections.js';
import { handleSystemRequest } from '../../server/system/middleware.js';
import { setRequestIngress } from '../../server/network/ingress.js';

const result = (code, stdout = '', stderr = '') => ({ code, stdout, stderr });

test('Fly falls back to flyctl and exposes only the command name and state', async () => {
  const commands = [];
  const profile = { id: 'wsl:Ubuntu', runtime: 'wsl' };
  const observed = await probeExternalConnection('fly', async (command, shellProfile) => {
    commands.push(command);
    assert.equal(shellProfile, profile);
    if (command.startsWith('fly ')) return result(127);
    return result(0, command.endsWith('whoami') ? 'account@example.com' : 'flyctl 0.5.3');
  }, profile);
  assert.deepEqual(commands, ['fly --version', 'flyctl --version', 'flyctl auth whoami']);
  assert.deepEqual(observed, { state: 'connected', bin: 'flyctl' });
});

test('Supabase distinguishes a missing CLI, missing sign-in, and a failed network check', async () => {
  assert.deepEqual(await probeExternalConnection('supabase', async () => result(1, '',
    "'supabase' is not recognized as an internal or external command")), { state: 'missing' });
  for (const [reply, state] of [
    [result(1, '', 'Access token not provided'), 'signed-out'],
    [result(1, '', 'network timeout'), 'unverified'],
    [result(0, '[]'), 'connected'],
  ]) {
    assert.deepEqual(await probeExternalConnection('supabase', async command =>
      command === 'supabase --version' ? result(0, '2.90.0') : reply), { state, bin: 'supabase' });
  }
});

test('Clerk accountless identity does not count as an account login', async () => {
  for (const [reply, state] of [
    [result(0, '{"email":null,"accountless":{"instanceId":"ins_example"}}'), 'signed-out'],
    [result(0, '{"email":"account@example.com","linked":null}'), 'connected'],
    [result(0, 'unexpected output'), 'unverified'],
  ]) {
    assert.deepEqual(await probeExternalConnection('clerk', async command =>
      command === 'clerk --version' ? result(0, '1.0.0') : reply), { state, bin: 'clerk' });
  }
});

test('a remote request is rejected before any CLI probes run', async () => {
  const req = { method: 'GET', minnowAuth: { kind: 'device' } };
  setRequestIngress(req, 'tailnet');
  const headers = new Map();
  const res = { setHeader: (key, value) => headers.set(key, value), end() {} };
  assert.equal(await handleSystemRequest(req, res, '/api/system/external-connections'), true);
  assert.equal(res.statusCode, 403);
  assert.equal(headers.get('Cache-Control'), 'no-store');
});
