import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createProductionRuntimeTestEnvironment } from './production-runtime-fixture.mjs';
import { installChatTools } from '../../server/chats/tools.js';

let environment;
before(async () => { environment = await createProductionRuntimeTestEnvironment(); });
after(async () => { await environment?.dispose(); });

test('production wait attention is reference counted and releasing one wait never clears another live wait', async t => {
  const f = await environment.fixture(t, { chats: { coordinator: {}, one: {}, two: {} }, respond: () => 'Unused' });
  f.repository.claimExecution({ chatId: 'coordinator', executionId: 'source', ownerId: 'host' });
  f.repository.claimExecution({ chatId: 'one', executionId: 'first', ownerId: 'host' });
  f.repository.claimExecution({ chatId: 'two', executionId: 'second', ownerId: 'host' });
  const { caller } = await f.runtime.context.executionCaller('source');
  const first = await f.runtime.beginChatWait({ caller, chatId: 'one', executionId: 'first' });
  const second = await f.runtime.beginChatWait({ caller, chatId: 'two', executionId: 'second' });
  assert.equal(f.runtime.presentation.frame('coordinator').fields.agentExecution.status, 'waiting_for_agents');
  first(); first();
  assert.equal(f.repository.getExecution('source').status, 'waiting_for_agents');
  second();
  assert.equal(f.repository.getExecution('source').status, 'running');
  assert.equal(f.calls.length, 0);
});

test('production wait disposal cannot replace a newer stopping or terminal execution state', async t => {
  const f = await environment.fixture(t, { chats: { coordinator: {}, peer: {} }, respond: () => 'Unused' });
  const fence = f.repository.claimExecution({ chatId: 'coordinator', executionId: 'source', ownerId: 'host' });
  f.repository.claimExecution({ chatId: 'peer', executionId: 'target', ownerId: 'host' });
  const { caller } = await f.runtime.context.executionCaller('source');
  const finish = await f.runtime.beginChatWait({ caller, chatId: 'peer', executionId: 'target' });
  f.repository.updateExecution('source', { status: 'stopping' }, { fence });
  finish();
  assert.equal(f.repository.getExecution('source').status, 'stopping');
  f.repository.updateExecution('source', { status: 'stopped' }, { fence });
  f.repository.releaseLease('coordinator', fence);
  finish();
  assert.equal(f.repository.getExecution('source').status, 'stopped');
});

test('two actual native wait calls detect a cycle and both canonical turns finish without stopping either peer', { timeout: 20000 }, async t => {
  let firstRequests = 0, release;
  const together = new Promise(resolve => { release = resolve; });
  const f = await environment.fixture(t, { chats: { coordinator: {}, peer: {} }, install: runtime => installChatTools(runtime),
    respond: async body => {
      if (body.messages.some(row => row.role === 'tool')) return 'Wait handled.';
      if (++firstRequests === 2) release();
      await together;
      const source = body.messages.filter(row => row.role === 'user').at(-1).content;
      return [{ id: source === 'First waits' ? 'first-wait' : 'second-wait', type: 'function', function: {
        name: 'chat_wait', arguments: JSON.stringify({ chat_id: source === 'First waits' ? 'peer' : 'coordinator', timeout_ms: 3000 }),
      } }];
    } });
  const [first, second] = await Promise.all([
    f.request('/api/chats/coordinator/commands', { action: 'send', text: 'First waits', clientRequestId: 'first' }),
    f.request('/api/chats/peer/commands', { action: 'send', text: 'Second waits', clientRequestId: 'second' }),
  ]);
  assert.equal(first.status, 202); assert.equal(second.status, 202);
  await f.runtime.service.idle();
  const rows = ['coordinator', 'peer'].flatMap(chatId => f.repository.readTranscript(chatId).messages.filter(row => row.role === 'tool'));
  assert.ok(rows.some(row => /wait_cycle|execution cycle/.test(row.content)), JSON.stringify({ rows,
    commands: f.repository.listCommands().map(row => ({ state: row.state, result: row.result, error: row.error })) }));
  assert.equal(f.repository.getCommand(first.body.receipt.commandId).state, 'settled');
  assert.equal(f.repository.getCommand(second.body.receipt.commandId).state, 'settled');
  assert.equal(f.repository.listCommands().some(row => row.command.kind === 'stop'), false);
  assert.ok(rows.some(row => /"state":"terminal"/.test(row.content)));
});
