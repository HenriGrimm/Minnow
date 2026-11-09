import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test, before, after } from 'node:test';
import { createProductionRuntimeTestEnvironment } from './production-runtime-fixture.mjs';
import { readCapabilities } from '../../server/providers/capabilities-store.js';

let environment;
before(async () => { environment = await createProductionRuntimeTestEnvironment(); });
after(async () => { await environment?.dispose(); });

test('managed chat completes a tool round despite persisted inconclusive capability probes', { timeout: 15000 }, async t => {
  const f = await environment.fixture(t, {
    toolNames: ['read_file'], chats: { chat: {} },
    install: async (_runtime, { modelAdapters }) => { modelAdapters.readCapabilities = readCapabilities; },
    respond: body => body.messages.some(row => row.role === 'tool') ? 'Read completed.' : [{
      id: 'read-call', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'sample.txt' }) },
    }],
  });
  await fs.writeFile(path.join(f.workspace, 'sample.txt'), 'Capability regression evidence.');
  await fs.writeFile(path.join(environment.root, 'home', 'providers', f.providerId, 'capabilities.json'), JSON.stringify({
    schemaVersion: 1, models: { model: {
      tools: false, streaming: false, sources: { tools: 'probe', streaming: 'probe' },
      probeErrors: { streaming: 'chat probe failed' },
    } },
  }));
  const accepted = await f.request('/api/chats/chat/commands', { action: 'send', text: 'Read sample.txt', clientRequestId: 'probe-regression' });
  assert.equal(accepted.status, 202);
  await f.runtime.service.idle();
  const command = f.repository.getCommand(accepted.body.receipt.commandId);
  assert.equal(command.state, 'settled', JSON.stringify(command.result));
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0].tools.some(row => row.function.name === 'read_file'));
  assert.ok(f.calls[1].messages.some(row => row.role === 'tool' && row.content.includes('Capability regression evidence.')));
  const messages = f.repository.readTranscript('chat').messages;
  assert.equal(messages.at(-1).content, 'Read completed.');
  assert.equal(f.repository.getLatestExecution('chat').status, 'completed');
});
