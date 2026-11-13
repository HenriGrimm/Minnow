import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentCliUpdates } from '../../server/models/agent-cli-updates.js';
import { admitAgentCli } from '../../server/generations/agent-cli/admission.js';
import { handleAgentCliModelsRequest } from '../../server/models/agent-cli-middleware.js';
import { setRequestIngress } from '../../server/network/ingress.js';

test('checks only installed CLIs and treats unparseable or ambiguous feeds as unavailable', async () => {
  const versions = { claude: '2.9.0 (Claude Code)', codex: null, cursor: '2026.11.11-abcdef0' };
  const requested = [];
  const updates = createAgentCliUpdates({
    detect: async kind => ({ installed: Boolean(versions[kind]), version: versions[kind] }),
    fetch: async url => {
      requested.push(url);
      return url.includes('cursor.com') ? new Response('DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.11.11-fedcba0/windows/x64/"')
        : Response.json({ version: '2.10.0' });
    },
  });
  const [first, second] = await Promise.all([updates.check(), updates.check(true)]);
  assert.deepEqual(first, second);
  assert.equal(requested.length, 2);
  assert.deepEqual(first.items.map(({ kind, state }) => [kind, state]), [['claude', 'available'], ['cursor', 'unavailable']]);
});

test('executes fixed updater argv once, protects active work and rechecks the installed version', async () => {
  let version = '1.1.0';
  let finish;
  let launched;
  const started = new Promise(resolve => { launched = resolve; });
  const providerId = 'claude-code-cli';
  const updates = createAgentCliUpdates({
    detect: async kind => kind === 'claude'
      ? { installed: true, version, resolvedCommand: 'fixture-cli', resolvedArgsPrefix: ['fixture.js'] }
      : { installed: false },
    fetch: async () => Response.json({ version: '1.2.0' }),
    run: async (command, args, options) => {
      launched({ command, args, options });
      await new Promise(resolve => { finish = resolve; });
      version = '1.2.0';
      return { code: 0 };
    },
  });
  assert.equal((await updates.check()).items[0].state, 'available');
  const release = await admitAgentCli(providerId);
  assert.throws(() => updates.update('claude'), /Finish or stop active/);
  release();
  const work = updates.update('claude');
  assert.equal(updates.update('claude'), work);
  const invocation = await started;
  await assert.rejects(admitAgentCli(providerId), /is updating/);
  assert.deepEqual(invocation.args, ['fixture.js', 'update']);
  assert.equal(invocation.command, 'fixture-cli');
  assert.equal(invocation.options.ignoreStdin, true);
  finish();
  assert.deepEqual(await work, { installedVersion: '1.2.0' });
  assert.equal((await updates.check()).items[0].state, 'current');
  (await admitAgentCli(providerId))();
});

test('paired ingress cannot launch CLI updates even with a loopback peer', async () => {
  const pathname = '/api/models/agent-clis/claude/update';
  const request = { method: 'POST', url: pathname, socket: { remoteAddress: '127.0.0.1' } };
  setRequestIngress(request, 'tailnet');
  const response = { setHeader() {}, end() {} };
  assert.equal(await handleAgentCliModelsRequest(request, response, pathname), true);
  assert.equal(response.statusCode, 403);
});
