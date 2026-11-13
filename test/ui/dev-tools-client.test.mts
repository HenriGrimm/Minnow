import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDevTool } from '../../src/api/dev-tools.ts';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('tool setup observes the host job, displays progress and polls to completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const methods: string[] = [];
  const messages: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, '/api/system/dev-tools/github');
    methods.push(options.method!);
    return new Response(JSON.stringify({ state: methods.length === 1 ? 'running' : 'ready', message: 'Setting up GitHub CLI…' }));
  });
  const work = installDevTool('github', new AbortController().signal, message => messages.push(message));
  await flush();
  t.mock.timers.tick(1000);
  await work;
  assert.deepEqual(methods, ['POST', 'GET']);
  assert.equal(messages.length, 2);
});

test('navigation stops polling without cancelling the host installation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(JSON.stringify({ state: 'running', message: 'Downloading…' }));
  });
  const controller = new AbortController();
  const work = installDevTool('codex', controller.signal);
  const rejected = assert.rejects(work, { name: 'AbortError' });
  await flush();
  controller.abort();
  await rejected;
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(calls, 1);
});

test('setup errors, remote denials and interrupted jobs remain retryable failures', async t => {
  for (const body of [{ state: 'error', error: 'Checksum failed. Retry here.' }, { error: 'Open Minnow on this computer.' }, { state: 'idle' }]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), { status: 'state' in body ? 200 : 403 }));
    await assert.rejects(installDevTool('claude', new AbortController().signal), /Retry|computer|interrupted/i);
  }
});
