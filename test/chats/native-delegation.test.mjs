import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createProductionRuntimeTestEnvironment } from './production-runtime-fixture.mjs';
import { installChatDelegation } from '../../server/chats/delegation.js';
import { ChatContractError } from '../../server/chats/contracts.js';

let environment;
before(async () => { environment = await createProductionRuntimeTestEnvironment(); });
after(async () => { await environment?.dispose(); });

test('native delegation preflight failure is a canonical tool result without a phantom child or false recovery barrier', { timeout: 15000 }, async t => {
  let starts = 0;
  const f = await environment.fixture(t, { chats: { coordinator: {} }, toolNames: ['spawn_sub_agent'],
    install: runtime => installChatDelegation(runtime, {
      getEngine: () => { starts++; throw new Error('Unavailable target must not enter the task graph'); },
      loadConfig: async () => ({ enabled: true, types: { explore: { enabled: true } } }),
      resolveModelSelection: async () => { throw new ChatContractError('model_unavailable', 'The requested exact model is unavailable'); },
    }),
    respond: body => body.messages.some(row => row.role === 'tool') ? 'The requested model is unavailable.' : [{
      id: 'spawn-unavailable', type: 'function', function: { name: 'spawn_sub_agent', arguments: JSON.stringify({
        type: 'explore', task: 'Inspect the code', target: { providerId: 'missing', modelId: 'unavailable' },
      }) },
    }],
  });
  const accepted = await f.request('/api/chats/coordinator/commands', { action: 'send', text: 'Delegate to the requested model', clientRequestId: 'delegate' });
  assert.equal(accepted.status, 202); await f.runtime.service.idle();
  const record = f.repository.getCommand(accepted.body.receipt.commandId);
  assert.equal(record.state, 'settled'); assert.equal(record.result.outcome, 'no_report');
  const rows = f.repository.readTranscript('coordinator').messages;
  assert.ok(rows.some(row => row.role === 'tool' && /model_unavailable/.test(row.content)));
  assert.equal(f.repository.listUnsettledToolInvocations(record.executionId).length, 0);
  assert.equal(f.repository.listChats().length, 1); assert.equal(starts, 0);
  assert.equal(f.repository.listOutbox().length, 0);
  assert.match(rows.at(-1).content, /unavailable/);
});
