import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createNativeEnforcementFixture, psQuote, exists } from '../fixtures/codex-native-enforcement.mjs';

test('installed CLI parked dynamic requests are NOT native quiescence; interrupt reaches a terminal turn and accepts actual results', {
  skip: process.env.MINNOW_CODEX_NATIVE_ENFORCEMENT !== '1' || process.platform !== 'win32', timeout: 30000,
}, async t => {
  const called = Promise.withResolvers();
  const f = await createNativeEnforcementFixture({ windowsSandbox: 'mxc', scoped: true,
    unifiedExec: false, onToolCall: row => called.resolve(row) });
  t.after(() => f.close());
  const thread = await f.rpc.request('thread/start', { model: 'gpt-5.5', cwd: f.workspace, ephemeral: false,
    approvalPolicy: 'never', permissions: 'minnow-write', dynamicTools: [{ type: 'function', name: 'pause',
      description: 'Pause fixture.', inputSchema: { type: 'object', properties: {} } }] });
  const file = path.join(f.workspace, 'parallel-native-marker.txt');
  f.endpoint.scripts.push({ calls: [{ id: 'parked', name: 'pause' }, { id: 'native-parallel', name: 'exec_command',
    args: { cmd: `Set-Content -LiteralPath ${psQuote(file)} -Value PARALLEL`, login: false } }] }, { text: 'Done.' });
  const started = await f.rpc.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Run fixture.' }] });
  await called.promise;
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(await exists(file), true, 'A parked dynamic request is not a native quiescence proof, even with unified_exec=false.');
  const terminal = Promise.withResolvers();
  const unsubscribe = f.rpc.subscribe(row => {
    if (row.method === 'turn/completed' && row.params.turn.id === started.turn.id) terminal.resolve(row.params.turn);
  });
  t.after(unsubscribe);
  await f.rpc.request('turn/interrupt', { threadId: thread.thread.id, turnId: started.turn.id });
  assert.equal((await terminal.promise).status, 'interrupted');
  const read = await f.rpc.request('thread/read', { threadId: thread.thread.id, includeTurns: true });
  assert.equal(read.thread.turns.at(-1).status, 'interrupted');
  await f.rpc.request('thread/inject_items', { threadId: thread.thread.id, items: [
    { type: 'function_call_output', call_id: 'parked', output: 'REAL_DYNAMIC_RESULT_AFTER_INTERRUPT' },
  ] });
  await f.rpc.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Continue using the actual completed tool result.' }] });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.match(JSON.stringify(f.endpoint.requests.at(-1).input), /REAL_DYNAMIC_RESULT_AFTER_INTERRUPT/);
});
