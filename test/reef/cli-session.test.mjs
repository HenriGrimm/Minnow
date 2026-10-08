import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reef-cli-session-')));
process.env.MINNOW_HOME = home;
const { createApp, updateApp, readApp } = await import('../../server/reef/store.js');
const { runAgent } = await import('../../server/reef/agent.js');
const { createGenerationState } = await import('../../server/generations/store.js');
const { pumpCodexAppServer } = await import('../../server/generations/codex-app-server/pump.js');
const { __setCodexInvocationForTests, codexSessionStats } = await import('../../server/generations/codex-app-server/manager.js');
const { disposeCliSessions } = await import('../../server/generations/agent-cli/lifecycle.js');
const { readCliCheckpoint } = await import('../../server/generations/agent-cli/checkpoints.js');
const fixture = fileURLToPath(new URL('../fixtures/fake-codex-conversation.mjs', import.meta.url));
const states = [];
const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }];
afterEach(async () => {
  await disposeCliSessions();
  __setCodexInvocationForTests();
  for (const state of states) clearTimeout(state.evictTimer);
  states.length = 0;
});
after(() => fs.rm(home, { recursive: true, force: true }));

async function generate(chatId, messages) {
  const state = createGenerationState({ providerId: 'codex-cli', chatId, fallbackRole: 'default',
    body: { model: 'fixture', stream: true, messages, tools } });
  states.push(state);
  await pumpCodexAppServer({ state, runtime: { profile: { agentCli: { kind: 'codex', maxConcurrent: 1 } }, secrets: {} },
    candidate: { providerId: 'codex-cli', modelId: 'fixture' }, index: 0, idleMs: 1000, maxMs: 5000, canFailover: false });
  assert.equal(state.status, 'complete', state.errorMessage);
  return Buffer.concat(state.chunks).toString().split('\n\n').filter(row => row.startsWith('data: {'))
    .flatMap(row => JSON.parse(row.slice(6)).choices?.[0]?.delta?.tool_calls ?? [])
    .map(({ index, ...call }) => call);
}

for (const outcome of ['success', 'failure', 'cancelled']) {
  test(`Reef ${outcome} releases only its own native CLI session, including pending tools`, async () => {
    let processes = 0;
    __setCodexInvocationForTests(session => {
      processes++;
      const scripts = Array.from({ length: 12 }, (_, i) => ({ calls: [{ id: `read-${i}`, name: 'mn_tool_0' }] }));
      scripts.push({ text: 'Done.' });
      return { command: process.execPath, argsPrefix: [fixture], cwd: session.home,
        env: { ...process.env, MINNOW_CODEX_SCRIPTS: JSON.stringify(scripts) } };
    });
    await generate('unrelated-chat', [{ role: 'user', content: 'Read another project.' }]);
    const app = await createApp({ prompt: 'A local counter', providerId: 'codex-cli', modelId: 'fixture' });
    const runId = randomUUID();
    await updateApp(app.id, current => current.runs.push({ id: runId, chatIds: [] }));
    const controller = new AbortController();
    let attemptChatId;
    const attempt = runAgent({ app, runId, workspace: home, prompt: 'Implement.', phase: 'build',
      baseUrl: 'http://unused', signal: controller.signal,
      execute: async (bin, args) => {
        attemptChatId = args[args.indexOf('--chat-id') + 1];
        const messages = [{ role: 'user', content: 'Read the source.' }];
        for (let round = 0; round < (outcome === 'success' ? 13 : 1); round++) {
          const calls = await generate(attemptChatId, messages);
          assert.equal(codexSessionStats().total, 2, 'all tool rounds must reuse one attempt process');
          if (calls.length) messages.push({ role: 'assistant', content: '', tool_calls: calls },
            ...calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: 'Source contents.' })));
        }
        if (outcome === 'cancelled') {
          controller.abort(new Error('Build cancelled'));
          throw controller.signal.reason;
        }
        await fs.writeFile(args[args.indexOf('--json-out') + 1], JSON.stringify({
          ok: outcome === 'success', assistantFinal: 'Done.', error: 'context budget exceeded',
        }));
        if (outcome === 'failure') throw new Error('Headless process failed');
      },
    });
    if (outcome === 'success') assert.equal((await attempt).text, 'Done.');
    else await assert.rejects(attempt, outcome === 'failure' ? /context budget exceeded/ : /Build cancelled/);
    assert.equal(processes, 2);
    assert.equal(codexSessionStats().total, 1, 'the unrelated pending chat must remain alive');
    assert.ok((await readApp(app.id)).chatIds.includes(attemptChatId), 'the attempt transcript binding is preserved');
    if (outcome === 'success') assert.equal((await readCliCheckpoint('codex-cli', attemptChatId)).clean, true);
  });
}
