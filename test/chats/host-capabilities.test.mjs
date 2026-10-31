import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatHostCapabilities } from '../../server/chats/host-capabilities.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const db = new Database(':memory:'); initSessionsSchema(db);
  let clock = 1000;
  const repository = createChatRepository({ db, now: () => clock });
  repository.createChat({ id: 'chat', workspacePath: 'C:/project' });
  const fence = repository.claimExecution({ chatId: 'chat', executionId: 'execution', ownerId: 'server' });
  const broker = createChatHostCapabilities({ repository, resolveProject: () => ({ projectId: 'project', workspaceRoot: 'C:/project' }), retryMs: 20, now: () => clock, ...options });
  const controller = new AbortController();
  const input = { name: 'browser_click', args: { ref: 'button', surface: 'user' }, ctx: { toolCallId: 'click' }, chatId: 'chat', executionId: 'execution', fence,
    signal: controller.signal, prepared: { policy: { modeId: 'plan' }, toolContext: { workAgentId: 'planner' } } };
  const frames = [];
  const register = (hostId = 'host', projectId = 'project', capabilities = ['tool:browser_click']) => broker.register({ hostId, projectId, capabilities, send: envelope => frames.push(envelope) });
  return { db, repository, broker, controller, input, frames, register, advance: ms => { clock += ms; }, cleanup() { broker.dispose(); db.close(); } };
}

test('durable host call pins exact project/tool, validates fence and commits its receipt before resolving', async () => {
  const s = fixture();
  try {
    s.register(); const waiting = s.broker.executeHostTool(s.input); await tick();
    const envelope = s.frames[0]; assert.ok(envelope);
    assert.equal(envelope.context.modeId, 'plan'); assert.equal(envelope.context.workspaceRoot, 'C:/project');
    assert.equal(envelope.context.workAgentId, 'planner');
    assert.equal(s.repository.getOutbox(envelope.invocationId).payload.hostId, 'host');
    assert.equal(s.repository.getOutbox(envelope.invocationId).state, 'applying');
    const result = { content: 'Clicked', attachments: [{ type: 'image', data: 'tiny' }] };
    assert.deepEqual(s.broker.respond({ hostId: 'host', invocationId: envelope.invocationId, result }), { accepted: true, replayed: false });
    assert.deepEqual(await waiting, result);
    assert.equal(s.repository.getOutbox(`result-${envelope.invocationId}`).state, 'applied');
    assert.equal(s.broker.pendingCount, 0);
    s.repository.updateExecution('execution', { status: 'completed' }, { fence: s.input.fence });
    s.repository.releaseLease('chat', s.input.fence);
    assert.equal(s.broker.respond({ hostId: 'host', invocationId: envelope.invocationId, result }).replayed, true);
    assert.throws(() => s.broker.respond({ hostId: 'host', invocationId: envelope.invocationId, result: { content: 'different' } }), { code: 'idempotency_conflict' });
  } finally { s.cleanup(); }
});

test('another host or project cannot take a dispatched invocation after disconnect or lease expiry', async () => {
  const s = fixture();
  try {
    const remove = s.register();
    const waiting = s.broker.executeHostTool(s.input); waiting.catch(() => {}); await tick();
    const invocationId = s.frames[0].invocationId;
    assert.throws(() => s.broker.respond({ hostId: 'host', invocationId, result: { content: 'Wrong request project' } }, { projectId: 'other-project' }), { code: 'caller_denied' });
    remove();
    s.register('other'); await tick();
    assert.equal(s.frames.filter(frame => frame.hostId === 'other').length, 0);
    assert.throws(() => s.broker.respond({ hostId: 'other', invocationId, result: { content: 'Forged' } }), { code: 'caller_denied' });
    s.register('host', 'wrong-project'); await tick();
    assert.throws(() => s.broker.respond({ hostId: 'host', invocationId, result: { content: 'Wrong project' } }), { code: 'caller_denied' });
    s.register(); await tick();
    assert.equal(s.frames.filter(frame => frame.type === 'execute').length, 2);
    assert.equal(s.frames.at(-1).invocationId, invocationId);
    s.advance(31_000);
    assert.throws(() => s.broker.respond({ hostId: 'host', invocationId, result: { content: 'Late' } }), { code: 'ownership_conflict' });
    s.controller.abort(); await assert.rejects(waiting);
  } finally { s.cleanup(); }
});

test('waiting requires exact capability and project; same-host replacement cleanup cannot unregister its reconnect', async () => {
  const s = fixture();
  try {
    s.register('wrong-project', 'other-project'); s.register('wrong-tool', 'project', ['tool:browser_snapshot']);
    const waiting = s.broker.executeHostTool(s.input); await tick();
    assert.equal(s.frames.length, 0);
    const removeOld = s.register(); await tick();
    s.register(); removeOld(); await tick();
    const envelope = s.frames.at(-1);
    assert.equal(envelope.hostId, 'host');
    s.broker.respond({ hostId: 'host', invocationId: envelope.invocationId, result: { content: 'Done' } });
    assert.equal((await waiting).content, 'Done');
  } finally { s.cleanup(); }
});

test('indeterminate reload is durably rejected as recovery work, and abort delivers a bound cancellation', async () => {
  const s = fixture();
  try {
    s.register(); const waiting = s.broker.executeHostTool(s.input); waiting.catch(() => {}); await tick();
    const envelope = s.frames[0];
    s.broker.respond({ hostId: 'host', invocationId: envelope.invocationId, indeterminate: true });
    await assert.rejects(waiting, { code: 'recovery_required' });
    assert.equal(s.repository.getOutbox(envelope.invocationId).state, 'failed');
    assert.equal(s.repository.getOutbox(`result-${envelope.invocationId}`).payload.indeterminate, true);
    const second = s.broker.executeHostTool({ ...s.input, ctx: { toolCallId: 'second' } }); second.catch(() => {}); await tick();
    s.controller.abort(new DOMException('Stopped', 'AbortError'));
    await assert.rejects(second, { name: 'AbortError' });
    assert.equal(s.frames.at(-1).type, 'cancel'); assert.equal(s.broker.pendingCount, 0);
  } finally { s.cleanup(); }
});

test('lost receipt response retransmits only to the pinned host, and transaction failure leaves no false acknowledgement', async () => {
  const s = fixture();
  try {
    s.register(); const waiting = s.broker.executeHostTool(s.input); await tick();
    const envelope = s.frames[0];
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(s.frames.length >= 2); assert.equal(s.frames.at(-1).invocationId, envelope.invocationId);
    const finish = s.repository.finishOutbox; let failed = false;
    s.repository.finishOutbox = (...args) => { if (!failed) { failed = true; throw new Error('Receipt commit lost'); } return finish(...args); };
    assert.throws(() => s.broker.respond({ hostId: 'host', invocationId: envelope.invocationId, result: { content: 'Done' } }), /Receipt commit/);
    assert.equal(s.repository.getOutbox(`result-${envelope.invocationId}`), null);
    s.broker.respond({ hostId: 'host', invocationId: envelope.invocationId, result: { content: 'Done' } });
    assert.equal((await waiting).content, 'Done');
  } finally { s.cleanup(); }
});

test('server restart never replays an orphaned callback and bounded input/result/host limits fail explicitly', async () => {
  const s = fixture({ maxHosts: 1, resultLimit: 1024, inputLimit: 128 });
  try {
    s.register(); assert.throws(() => s.register('other'), { code: 'queue_full' });
    await assert.rejects(s.broker.executeHostTool({ ...s.input, args: { value: 'x'.repeat(129) } }), { code: 'invalid_request' });
    const waiting = s.broker.executeHostTool(s.input); waiting.catch(() => {}); await tick();
    const envelope = s.frames[0];
    assert.throws(() => s.broker.respond({ hostId: 'host', invocationId: envelope.invocationId, result: { content: 'x'.repeat(1024) } }), { code: 'invalid_request' });
    const replacement = createChatHostCapabilities({ repository: s.repository, resolveProject: () => ({ projectId: 'project', workspaceRoot: 'C:/project' }) });
    const replay = [];
    replacement.register({ hostId: 'host', projectId: 'project', capabilities: ['tool:browser_click'], send: frame => replay.push(frame) });
    assert.deepEqual(replay, [{ version: 1, type: 'cancel', invocationId: envelope.invocationId }]);
    replacement.dispose(); s.controller.abort(); await assert.rejects(waiting);
  } finally { s.cleanup(); }
});

test('revocation after possible dispatch cancels the original host and remains indeterminate', async () => {
  let allowed = true;
  const s = fixture({ beforeDispatch() { if (!allowed) throw Object.assign(new Error('Permission was revoked'), { code: 'policy_denied' }); } });
  try {
    s.register(); const waiting = s.broker.executeHostTool(s.input); waiting.catch(() => {}); await tick();
    assert.equal(s.frames[0].type, 'execute'); allowed = false;
    await assert.rejects(waiting, /Permission was revoked/);
    assert.equal(s.frames.at(-1).type, 'cancel'); assert.equal(s.broker.pendingCount, 0);
    assert.equal(s.repository.getOutbox(s.frames[0].invocationId).state, 'applying');
  } finally { s.cleanup(); }
});
