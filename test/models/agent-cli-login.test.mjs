import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { agentCliLoginUrl, createAgentCliLoginService } from '../../server/models/agent-cli-login.js';

function harness(options = {}) {
  const children = [];
  const calls = [];
  const stopped = [];
  const service = createAgentCliLoginService({
    resolveBin: async () => ({ command: 'vendor', argsPrefix: ['cli.js'] }),
    spawnProcess(command, args, config) {
      calls.push({ command, args, config });
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      children.push(child);
      return child;
    },
    stop: async child => { stopped.push(child); },
    verify: async () => ({ authStatus: 'signed-in' }),
    ...options,
  });
  return { service, children, calls, stopped };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('login links only allow vendor HTTPS origins', () => {
  for (const url of ['javascript:alert(1)', 'http://claude.ai/oauth', 'https://claude.ai.evil.com',
    'https://user:pass@claude.ai', 'https://claude.ai:9999', 'https://example.com/?token=private']) {
    assert.equal(agentCliLoginUrl('claude', url), null);
  }
  assert.equal(agentCliLoginUrl('claude', 'https://claude.ai/oauth/authorize?state=test'), 'https://claude.ai/oauth/authorize?state=test');
});

test('one bounded process per kind; fixed argv, normalized output, completion verified', async () => {
  const signedIn = [];
  const { service, children, calls } = harness({ onSignedIn: async kind => signedIn.push(kind) });
  const [a, b] = await Promise.all([service.start('claude'), service.start('claude')]);
  assert.equal(a.id, b.id);
  assert.equal(children.length, 1);
  assert.deepEqual(calls[0].args, ['cli.js', 'auth', 'login']);
  assert.equal(calls[0].config.shell, false);
  assert.equal(calls[0].config.windowsHide, true);
  children[0].stderr.write('private-token-do-not-display\nhttps://claude.ai/oauth/');
  children[0].stderr.write('authorize?state=test\n');
  const waiting = service.poll('claude', a.id);
  assert.equal(waiting.verificationUrl, 'https://claude.ai/oauth/authorize?state=test');
  assert.equal(waiting.state, 'waiting');
  assert.equal(JSON.stringify(waiting).includes('private-token'), false);
  let input = '';
  children[0].stdin.on('data', chunk => { input += chunk; });
  service.submit('claude', a.id, 'test-code#state');
  assert.equal(input, 'test-code#state\n');
  assert.throws(() => service.submit('claude', a.id, 'bad\ncode'));
  children[0].emit('close', 0);
  await tick();
  assert.equal(service.poll('claude', a.id).state, 'signed-in');
  assert.equal(service.poll('claude', a.id).verificationUrl, null);
  assert.deepEqual(signedIn, ['claude']);
});

test('cancel rejects stale attempts, kills process and ignores late completion', async () => {
  let verified = 0;
  const { service, children, stopped, calls } = harness({ verify: async () => { verified++; return { authStatus: 'signed-in' }; } });
  const first = await service.start('codex');
  assert.deepEqual(calls[0].args, ['cli.js', '-c', 'cli_auth_credentials_store=file', 'login']);
  await service.cancel('codex', first.id);
  children[0].emit('close', 0);
  await tick();
  assert.equal(verified, 0);
  assert.equal(stopped.length, 1);
  const second = await service.start('codex');
  assert.notEqual(first.id, second.id);
  assert.throws(() => service.poll('codex', first.id));
  await service.cancel('codex', second.id);
});

test('failed verification and spawn errors never expose vendor diagnostics', async () => {
  const { service, children } = harness({ verify: async () => { throw new Error('secret'); } });
  const flow = await service.start('claude');
  children[0].emit('close', 0);
  await tick();
  assert.equal(service.poll('claude', flow.id).state, 'failed');
  assert.equal(JSON.stringify(service.poll('claude', flow.id)).includes('secret'), false);
  const cursor = await service.start('cursor');
  children[1].emit('error', new Error('secret'));
  assert.equal(service.poll('cursor', cursor.id).state, 'failed');
});

test('timeout terminates the attempt and Cursor exposes a browser link and device code', async () => {
  const { service, children, calls, stopped } = harness({ timeoutMs: 15 });
  const flow = await service.start('cursor');
  assert.equal(calls[0].config.env.NO_OPEN_BROWSER, '1');
  children[0].stdout.write('https://cursor.com/login?challenge=test\ncode: ABCD-1234\n');
  assert.equal(service.poll('cursor', flow.id).code, 'ABCD-1234');
  assert.throws(() => service.submit('cursor', flow.id, 'wrong'));
  await new Promise(resolve => setTimeout(resolve, 30));
  const expired = service.poll('cursor', flow.id);
  assert.equal(expired.state, 'failed');
  assert.equal(expired.verificationUrl, null);
  assert.equal(stopped.length, 1);
});

test('shutdown stops live attempts immediately and prevents late process startup', async () => {
  const { service, stopped } = harness();
  await service.start('claude');
  const closing = service.shutdown();
  assert.equal(stopped.length, 1);
  await closing;
  await assert.rejects(service.start('codex'), /shutting down/);
  let resolved;
  const late = harness({ resolveBin: () => new Promise(resolve => { resolved = resolve; }) });
  const starting = late.service.start('claude');
  await tick();
  const closed = late.service.shutdown();
  resolved({ command: 'vendor', argsPrefix: [] });
  await assert.rejects(starting, /shutting down/);
  await closed;
  assert.equal(late.children.length, 0);
});
