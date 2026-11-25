import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, before, after } from 'node:test';
import { createProductionRuntimeTestEnvironment } from './production-runtime-fixture.mjs';

let environment, coordination, agentTransport;
before(async () => {
  environment = await createProductionRuntimeTestEnvironment();
  coordination = await import('../../server/chats/tools.js');
  agentTransport = await import('../../server/chats/agent-tools-middleware.js');
});
after(async () => { await environment?.dispose(); });
const tool = (name, args, id = 'coordination-call') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const lastUser = body => body.messages.filter(row => row.role === 'user').at(-1)?.content;
const install = async runtime => coordination.installChatTools(runtime);
async function pendingRequest(fixture, chatId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const records = fixture.repository.listRequests(chatId);
    if (records.length) return records[0];
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected a durable approval for ' + chatId);
}

for (const permissionLevel of ['manual', 'auto', 'full']) test(`chat_send respects ${permissionLevel} in production and preserves agent provenance`, { timeout: 20000 }, async t => {
  const f = await environment.fixture(t, { install, respond: body => {
    if (lastUser(body) === 'Coordinate with peer' && !body.messages.some(row => row.role === 'tool')) {
      return [tool('chat_send', { chat_id: 'peer', message: 'Peer instruction', mode: 'auto', client_request_id: 'peer-input' })];
    }
    return String(lastUser(body)).includes('Peer instruction') ? 'Peer answered.' : 'Coordinator finished.';
  } });
  f.settings.meta.toolSecurity.permissionLevel = permissionLevel;
  const accepted = await f.request('/api/chats/coordinator/commands', { action: 'send', text: 'Coordinate with peer', clientRequestId: 'coordinate' });
  assert.equal(accepted.status, 202);
  if (permissionLevel !== 'full') {
    const pending = await pendingRequest(f, 'coordinator');
    assert.equal(pending.presentation.arguments.message, 'Peer instruction');
    assert.equal(f.repository.listCommands({ chatId: 'peer' }).length, 0);
    const approval = await f.request('/api/chats/coordinator/requests/' + pending.requestId + '/respond',
      { answer: { decision: 'allow_once' }, clientRequestId: 'allow-peer' });
    assert.equal(approval.status, 200);
  }
  await f.runtime.service.idle();
  if (permissionLevel === 'full') assert.equal(f.repository.listRequests('coordinator').length, 0);
  const source = f.repository.getCommand(accepted.body.receipt.commandId);
  assert.equal(source.state, 'settled');
  const toolRow = f.repository.readTranscript('coordinator').messages.find(row => row.role === 'tool');
  assert.ok(toolRow, JSON.stringify(source.result));
  const receipt = JSON.parse(toolRow.content);
  assert.equal(receipt.chatId, 'peer');
  const peer = f.repository.getCommand(receipt.commandId);
  assert.equal(peer.state, 'settled');
  assert.equal(peer.command.provenance.actor, 'agent');
  assert.equal(peer.command.provenance.sourceChatId, 'coordinator');
  assert.equal(peer.command.provenance.sourceTurnId, source.executionId);
  assert.equal(f.repository.readTranscript('peer').messages[0].provenance.commandId, peer.commandId);
  assert.equal(f.calls.filter(body => String(lastUser(body)).includes('Peer instruction')).length, 1);
  assert.ok(f.calls[0].tools.some(row => row.function.name === 'chat_send'));
  assert.ok(f.calls[0].tools.some(row => row.function.name === 'agent_capabilities'));
  assert.equal(f.calls.some(body => body.messages.some(row => row.provenance || row.commandId || row.messageId)), false);
});

test('/plan cannot start work in another chat through native coordination', { timeout: 20000 }, async t => {
  const f = await environment.fixture(t, { install, chats: { coordinator: {}, peer: {}, foreign: { foreign: true } },
    respond: body => body.messages.some(row => row.role === 'tool') ? 'Dispatch was refused.' : [
      tool('chat_send', { chat_id: 'peer', message: 'Attempt broader work' }, 'broader-call'),
      tool('chat_send', { chat_id: 'foreign', message: 'Attempt cross-project work' }, 'foreign-call'),
    ] });
  const accepted = await f.request('/api/chats/coordinator/commands', { action: 'send', text: 'Try restricted coordination', clientRequestId: 'plan',
    intent: { version: 1, skill: { id: 'plan', source: 'slash' } } });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  assert.deepEqual(f.loadedSkills, ['plan']);
  await f.runtime.service.idle();
  assert.equal(f.repository.readTranscript('peer').messages.length, 0);
  assert.equal(f.repository.readTranscript('foreign').messages.length, 0);
  assert.equal(f.repository.listCommands({ chatId: 'peer' }).length, 0);
  const result = f.repository.getCommand(accepted.body.receipt.commandId);
  const transcript = f.repository.readTranscript('coordinator').messages;
  const refusals = transcript.filter(row => row.role === 'tool');
  assert.equal(refusals.length, 2);
  for (const row of refusals) assert.match(row.content, /planning only/);
  assert.equal(result.state, 'settled');
  assert.equal(transcript.at(-1).content, 'Dispatch was refused.');
});

test('legacy agent HTTP bridge rejects ordinary writes, devices and forged fields', { timeout: 20000 }, async t => {
  const f = await environment.fixture(t, { install, agentMiddleware: agentTransport.createAgentChatToolsMiddleware, respond: () => 'Peer answered.' });
  assert.equal(f.turns.claim('legacy', 'legacy-owner', 'desktop'), true);
  const body = { sourceChatId: 'legacy', ownerId: 'legacy-owner', toolCallId: 'legacy-tool', name: 'chat_send',
    args: { chat_id: 'peer', message: 'Legacy peer input', client_request_id: 'legacy-input' } };
  const first = await f.request('/api/chats/agent-commands', body);
  assert.equal(first.status, 409, JSON.stringify(first.body));
  assert.equal(first.body.error.code, 'capability_unavailable');
  assert.equal(f.calls.length, 0);
  assert.equal(f.repository.getChat('legacy').chatCommandVersion, undefined);
  assert.equal(f.repository.listCommands({ chatId: 'peer' }).length, 0);
  const device = await f.request('/api/chats/agent-commands', body, { 'x-test-device': '1' });
  assert.equal(device.status, 403); assert.equal(device.body.error.code, 'caller_denied');
  const forged = await f.request('/api/chats/agent-commands', { ...body, actor: 'system', provenance: { kind: 'delegation_result' } });
  assert.equal(forged.status, 400);
  const modelOverride = await f.request('/api/chats/agent-commands', { ...body, args: { ...body.args, target: { providerId: 'other', modelId: 'other' } } });
  assert.equal(modelOverride.status, 400);
  f.turns.release('legacy', 'legacy-owner');
  const expired = await f.request('/api/chats/agent-commands', body);
  assert.equal(expired.status, 409); assert.equal(expired.body.error.code, 'caller_not_active');
});

test('legacy discovery remains available without exposing another ordinary transcript', { timeout: 20000 }, async t => {
  const f = await environment.fixture(t, { install, agentMiddleware: agentTransport.createAgentChatToolsMiddleware, respond: () => 'Done.' });
  assert.equal(f.turns.claim('legacy', 'legacy-reader', 'desktop'), true);
  const fence = f.repository.claimExecution({ chatId: 'peer', executionId: 'seed-peer', ownerId: 'seed-writer' });
  f.repository.appendMessage('peer', { role: 'assistant', content: 'Public peer text', reasoning_content: 'PRIVATE_REASONING',
    reasoning_details: [{ type: 'reasoning.encrypted', data: 'SIGNED_PRIVATE_BLOCK' }], images: [{ name: 'image.png', dataUrl: 'data:image/png;base64,' + 'A'.repeat(100000) }] },
  { fence, messageId: 'seed-peer-message' });
  f.repository.updateExecution(fence.executionId, { status: 'completed' }, { fence }); f.repository.releaseLease('peer', fence);
  const readTranscript = f.repository.readTranscript;
  f.repository.readTranscript = () => { throw new Error('Coordination reads must use bounded SQL projection'); };
  try {
    const base = { sourceChatId: 'legacy', ownerId: 'legacy-reader', toolCallId: 'read-tool' };
    const list = await f.request('/api/chats/agent-commands', { ...base, name: 'chat_list', args: { limit: 20 } });
    assert.equal(list.status, 200);
    assert.ok(list.body.result.chats.some(row => row.chat_id === 'legacy'));
    assert.equal(list.body.result.chats.some(row => row.chat_id === 'foreign'), false);
    const read = await f.request('/api/chats/agent-commands', { ...base, name: 'chat_read', args: { chat_id: 'peer', limit: 1 } });
    assert.equal(read.status, 409);
    assert.equal(read.body.error.code, 'capability_unavailable');
    const wire = JSON.stringify(read.body);
    assert.doesNotMatch(wire, /PRIVATE_REASONING|SIGNED_PRIVATE_BLOCK|data:image/);
    assert.ok(wire.length < 5000);
  } finally { f.repository.readTranscript = readTranscript; }
  f.turns.release('legacy', 'legacy-reader');
});

test('raw renderer Manual tool approval cannot substitute for ordinary chat consent', { timeout: 20000 }, async t => {
  const f = await environment.fixture(t, { install, agentMiddleware: agentTransport.createAgentChatToolsMiddleware, respond: () => 'Approved peer result.' });
  f.settings.meta.toolSecurity.permissionLevel = 'manual';
  assert.equal(f.turns.claim('legacy', 'legacy-ask-owner', 'desktop'), true);
  const body = { sourceChatId: 'legacy', ownerId: 'legacy-ask-owner', toolCallId: 'ask-call', name: 'chat_send',
    args: { chat_id: 'peer', message: 'Approved peer input', client_request_id: 'ask-input' } };
  const accepted = await f.request('/api/chats/agent-commands', body);
  assert.equal(accepted.status, 409, JSON.stringify(accepted.body));
  assert.equal(accepted.body.error.code, 'capability_unavailable');
  assert.deepEqual(f.repository.listRequests('legacy', null), []);
  assert.equal(f.repository.listCommands({ chatId: 'peer' }).length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.repository.getChat('legacy').chatCommandVersion, undefined);
  f.turns.release('legacy', 'legacy-ask-owner');
});

test('raw approval rechecks tool availability and exact owner revocation', { timeout: 20000 }, async t => {
  const toolNames = ['chat_stop', 'chat_read'];
  const f = await environment.fixture(t, { install, toolNames, agentMiddleware: agentTransport.createAgentChatToolsMiddleware, respond: () => 'Must not run.' });
  f.settings.meta.toolSecurity.permissionLevel = 'manual';
  assert.equal(f.turns.claim('legacy', 'revocable-owner', 'desktop'), true);
  const body = { sourceChatId: 'legacy', ownerId: 'revocable-owner', toolCallId: 'off-call', name: 'chat_stop',
    args: { chat_id: 'legacy', execution_id: 'stale-turn' } };
  const attempt = f.request('/api/chats/agent-commands', body);
  const request = await pendingRequest(f, 'legacy');
  toolNames.shift();
  const answered = await f.request('/api/chats/legacy/requests/' + request.requestId + '/respond',
    { answer: { decision: 'allow_once' }, clientRequestId: 'off-answer' });
  assert.equal(answered.status, 200);
  assert.equal((await attempt).status, 403);
  assert.equal(f.repository.listCommands({ chatId: 'peer' }).length, 0);
  toolNames.unshift('chat_stop');
  const next = f.request('/api/chats/agent-commands', { ...body, toolCallId: 'released-call' });
  const releaseRequest = await pendingRequest(f, 'legacy');
  f.turns.release('legacy', 'revocable-owner');
  assert.equal((await next).status, 409);
  assert.equal(f.repository.getRequest(releaseRequest.requestId).state, 'cancelled');
  assert.equal(f.calls.length, 0);
});

test('managed native Manual approval uses the same durable approval without a duplicate permission prompt', { timeout: 20000 }, async t => {
  const f = await environment.fixture(t, { install, respond: body => {
    if (lastUser(body) === 'Native Ask coordination' && !body.messages.some(row => row.role === 'tool')) {
      return [tool('chat_send', { chat_id: 'peer', message: 'Native approved input' }, 'native-ask-call')];
    }
    return 'Completed after approval.';
  } });
  f.settings.meta.toolSecurity.permissionLevel = 'manual';
  const accepted = await f.request('/api/chats/coordinator/commands',
    { action: 'send', text: 'Native Ask coordination', clientRequestId: 'native-ask' });
  assert.equal(accepted.status, 202);
  const request = await pendingRequest(f, 'coordinator');
  assert.equal(f.repository.getExecution(request.executionId).status, 'waiting_for_approval');
  const answer = await f.request('/api/chats/coordinator/requests/' + request.requestId + '/respond',
    { answer: { decision: 'allow_once' }, clientRequestId: 'native-answer' });
  assert.equal(answer.status, 200);
  await f.runtime.service.idle();
  assert.equal(f.repository.listRequests('coordinator', null).length, 1);
  assert.equal(f.repository.listCommands({ chatId: 'peer' }).length, 1);
  assert.equal(f.repository.getCommand(accepted.body.receipt.commandId).state, 'settled');
});

for (const level of ['auto', 'full']) test(`${level === 'full' ? 'Full access' : 'confirmed'} creation runs a separate ordinary chat and the user can continue it`, { timeout: 20000 }, async t => {
  const f = await environment.fixture(t, { install, toolNames: ['chat_create', 'chat_wait'], respond: body => {
    if (lastUser(body) === 'Open a new chat for review and tell me what it finds') {
      const outputs = body.messages.filter(row => row.role === 'tool');
      if (!outputs.length) return [tool('chat_create', { title: 'Release review', message: 'Review the changelog', report_back: true }, 'create-review')];
      if (outputs.length === 1) {
        const receipt = JSON.parse(outputs[0].content);
        return [tool('chat_wait', { chat_id: receipt.chatId, timeout_ms: 3000 }, 'wait-for-review')];
      }
      return 'Reported the review.';
    }
    return String(lastUser(body)).includes('Review the changelog') ? 'Changelog checked.' : 'I can continue.';
  } });
  f.settings.meta.toolSecurity.permissionLevel = level;
  const { scope } = await f.runtime.context.resolveTarget('coordinator');
  const views = [[], []];
  const subscriptions = views.map(events => f.runtime.presentation.subscribe({
    projectId: scope.projectId, chatId: 'coordinator', send: event => events.push(event),
  }));
  t.after(() => subscriptions.forEach(dispose => dispose()));
  const sent = await f.request('/api/chats/coordinator/commands', { action: 'send',
    text: 'Open a new chat for review and tell me what it finds', clientRequestId: 'review-source' });
  assert.equal(sent.status, 202);
  if (level !== 'full') {
    const pending = await pendingRequest(f, 'coordinator');
    assert.equal(pending.presentation.arguments.firstMessage, 'Review the changelog');
    assert.equal(f.repository.listChats().some(chat => chat.name === 'Release review'), false);
    const response = await f.request('/api/chats/coordinator/requests/' + pending.requestId + '/respond',
      { answer: { decision: 'allow_once' }, clientRequestId: 'allow-create' });
    assert.equal(response.status, 200);
  }
  await f.runtime.service.idle();
  const results = f.repository.readTranscript('coordinator').messages.filter(row => row.role === 'tool');
  assert.equal(results.length, 2, JSON.stringify(results));
  const receipt = JSON.parse(results[0].content);
  assert.equal(JSON.parse(results[1].content).assistant_final, 'Changelog checked.');
  for (const events of views) assert.ok(events.some(event => event.kind === 'chat-changed' && event.chatId === receipt.chatId
    && event.fields.name === 'Release review' && event.fields.explicitOrdinaryRoot === true && !event.fields.agentConversation));
  assert.equal(f.repository.getRelation(receipt.chatId), null);
  assert.equal(f.repository.getChat(receipt.chatId).name, 'Release review');
  assert.equal(f.repository.readTranscript(receipt.chatId).messages[0].provenance.sourceChatId, 'coordinator');
  const takeover = await f.request('/api/chats/' + receipt.chatId + '/commands', { action: 'send', text: 'Continue here', clientRequestId: 'take-over' });
  assert.equal(takeover.status, 202, JSON.stringify(takeover.body));
  await f.runtime.service.idle(receipt.chatId);
  assert.equal(f.repository.readTranscript(receipt.chatId).messages.at(-1).content, 'I can continue.');
});

for (const firstMessage of [true, false]) test(`chat_create enables a multi-repo worktree ${firstMessage ? 'with a first message and report' : 'before a human sends the first message'}`, { timeout: 30000 }, async t => {
  const exec = promisify(execFile);
  const repos = ['frontend', 'services/backend'];
  const f = await environment.fixture(t, {
    async install(runtime, { workspace }) {
      for (const id of repos) {
        const cwd = path.join(workspace, id);
        const git = (...args) => exec('git', args, { cwd, windowsHide: true });
        await fs.mkdir(cwd, { recursive: true });
        await git('init');
        await fs.writeFile(path.join(cwd, 'tracked.txt'), 'committed ' + id);
        await git('add', '.');
        await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'base');
        await fs.writeFile(path.join(cwd, 'tracked.txt'), 'uncommitted ' + id);
      }
      return install(runtime);
    },
    toolNames: ['chat_create', 'chat_wait'],
    respond(body) {
      if (lastUser(body) !== 'Open an isolated chat') return 'Isolated work finished.';
      const outputs = body.messages.filter(row => row.role === 'tool');
      if (!outputs.length) return [tool('chat_create', { title: 'Isolated chat', enable_worktree: true,
        ...(firstMessage ? { message: 'Inspect both repos', report_back: true } : {}) }, 'create-isolated')];
      if (firstMessage && outputs.length === 1) {
        return [tool('chat_wait', { chat_id: JSON.parse(outputs[0].content).chatId, timeout_ms: 10000 }, 'wait-isolated')];
      }
      return 'Done.';
    },
  });
  f.settings.meta.toolSecurity.permissionLevel = firstMessage ? 'auto' : 'full';
  const sent = await f.request('/api/chats/coordinator/commands', { action: 'send', text: 'Open an isolated chat', clientRequestId: 'source' });
  assert.equal(sent.status, 202);
  if (firstMessage) {
    const pending = await pendingRequest(f, 'coordinator');
    assert.match(pending.presentation.arguments.checkout, /New isolated worktree from/);
    assert.equal(f.repository.listChats().some(chat => chat.name === 'Isolated chat'), false);
    const confirmation = await f.request('/api/chats/coordinator/requests/' + pending.requestId + '/respond',
      { answer: { decision: 'allow_once' }, clientRequestId: 'allow-isolated' });
    assert.equal(confirmation.status, 200);
  }
  await f.runtime.service.idle();
  const outputs = f.repository.readTranscript('coordinator').messages.filter(row => row.role === 'tool');
  const { chatId, commandId } = JSON.parse(outputs[0].content);
  if (firstMessage) {
    assert.equal(JSON.parse(outputs[1].content).assistant_final, 'Isolated work finished.');
  } else {
    assert.equal(commandId, undefined);
    const blank = f.repository.getChat(chatId);
    assert.equal(blank.worktreeEnabled, true);
    assert.ok(!blank.worktreeSetupRequired && !blank.workspacePreparation && !blank.worktreeRoot);
    assert.equal(f.calls.length, 2);
    const cwd = path.join(f.workspace, 'frontend');
    await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'new source HEAD'], { cwd, windowsHide: true });
    const first = await f.request('/api/chats/' + chatId + '/commands', { action: 'send', text: 'Inspect both repos', clientRequestId: 'human-first' });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    await f.runtime.service.idle(chatId);
  }
  const chat = f.repository.getChat(chatId);
  assert.equal(chat.workspacePreparation.status, 'ready', JSON.stringify(chat.workspacePreparation));
  assert.notEqual(path.resolve(chat.worktreeRoot), path.resolve(f.workspace));
  assert.equal(f.repository.listCommands({ chatId })[0].captured.scope.canonicalKey, (await f.runtime.context.resolveTarget(chatId)).scope.canonicalKey);
  assert.equal(f.repository.readTranscript(chatId).messages.at(-1).content, 'Isolated work finished.');
  if (!firstMessage) {
    const { stdout } = await exec('git', ['log', '-1', '--format=%s'], { cwd: path.join(chat.worktreeRoot, 'frontend'), windowsHide: true });
    assert.equal(stdout.trim(), 'new source HEAD');
  }
  for (const id of repos) {
    assert.equal(await fs.readFile(path.join(chat.worktreeRoot, id, 'tracked.txt'), 'utf8'), 'committed ' + id);
    assert.equal(await fs.readFile(path.join(f.workspace, id, 'tracked.txt'), 'utf8'), 'uncommitted ' + id);
  }
});

test('a Full access manager follows up across turns and retries failed isolated setup', { timeout: 45000 }, async t => {
  let assignment, failedOnce = false;
  const git = promisify(execFile);
  const { enableChatWorktree } = await import('../../server/worktree/worktree-ops.js');
  const f = await environment.fixture(t, {
    runtimeOptions: { enableChatWorktree: async options => {
      const result = await enableChatWorktree(options);
      if (result.ok && options.title === 'Assigned issue' && !failedOnce) {
        failedOnce = true;
        return { ok: false, error: 'Worktree kept. Setup failed: npm (exit 2: fixture secret)' };
      }
      return result;
    } },
    async install(runtime, { workspace, modelAdapters }) {
      const exec = (...args) => git('git', args, { cwd: workspace, windowsHide: true });
      await exec('init');
      await fs.writeFile(path.join(workspace, 'readme.txt'), 'fixture');
      await exec('add', '.');
      await exec('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'base');
      modelAdapters.listModels = async () => [{ id: 'model', reasoning: { allowed_options: ['medium', 'high'] } }];
      return install(runtime);
    },
    toolNames: ['chat_create', 'chat_read', 'chat_send', 'chat_wait', 'chat_retry_worktree'],
    respond(body) {
      const result = id => body.messages.find(row => row.role === 'tool' && row.tool_call_id === id);
      switch (lastUser(body)) {
        case 'Initialize other manager': return 'Ready.';
        case 'Create issue assignment':
          return result('assign') ? 'Assignment admitted.' : [tool('chat_create', { title: 'Assigned issue', message: 'Plan the issue',
            enable_worktree: true, report_back: true, reasoning_effort: 'high', provider_id: f.providerId, model_id: 'model' }, 'assign')];
        case 'Create independent assignment':
          return result('assign-other') ? 'Assignment admitted.' : [tool('chat_create', { title: 'Independent assignment',
            message: 'Plan another issue', enable_worktree: true, report_back: true }, 'assign-other')];
        case 'Read someone else’s assignment':
          return result('other-read') ? 'Done.' : [tool('chat_read', { chat_id: assignment.chatId }, 'other-read')];
        case 'Try to continue on Local':
          return result('detached-send') ? 'Done.' : [tool('chat_send', { chat_id: assignment.chatId, message: 'Must not run in Local' }, 'detached-send')];
        case 'Recover and continue assignment': {
          const address = { chat_id: assignment.chatId };
          if (!result('check-initial')) return [tool('chat_wait', { ...address, command_id: assignment.commandId }, 'check-initial')];
          const setup = JSON.parse(result('check-initial').content).worktree_setup;
          if (!result('retry-setup')) return [tool('chat_retry_worktree', { ...address, intent_id: setup.intent_id }, 'retry-setup')];
          if (!result('read-ready')) return [tool('chat_read', address, 'read-ready')];
          if (!result('send-plan')) return [tool('chat_send', { ...address, message: 'Plan the issue' }, 'send-plan')];
          if (!result('wait-plan')) return [tool('chat_wait', { ...address, command_id: JSON.parse(result('send-plan').content).commandId, timeout_ms: 5000 }, 'wait-plan')];
          return 'Plan handoff received.';
        }
        default: return 'Here is the plan.';
      }
    },
  });
  f.settings.meta.toolSecurity.permissionLevel = 'full';
  const send = async (chatId, text, clientRequestId) => {
    const response = await f.request('/api/chats/' + chatId + '/commands', { action: 'send', text, clientRequestId });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    await f.runtime.service.idle();
  };
  const toolResult = (chatId, callId) => {
    const messages = f.repository.readTranscript(chatId).messages;
    const row = messages.findLast(row => row.role === 'tool' && row.tool_call_id === callId);
    assert.ok(row, JSON.stringify(messages.map(({ role, tool_call_id, content }) => ({ role, tool_call_id, content }))));
    return row.content;
  };
  await send('peer', 'Initialize other manager', 'initialize-peer');
  await send('coordinator', 'Create issue assignment', 'create-assignment');
  assignment = JSON.parse(toolResult('coordinator', 'assign'));
  assert.equal(assignment.modelSelection.options.reasoningEffort, 'high');
  const initial = f.repository.getCommand(assignment.commandId);
  assert.equal(initial.state, 'failed');
  assert.equal(f.repository.getChat(assignment.chatId).workspacePreparation.status, 'failed');
  await send('coordinator', 'Create independent assignment', 'create-independent');
  const other = JSON.parse(toolResult('coordinator', 'assign-other'));
  assert.equal(f.repository.getCommand(other.commandId).state, 'settled');
  assert.equal(f.repository.getChat(assignment.chatId).workspacePreparation.status, 'failed');

  // A retained profile and report created before the retry tool existed do
  // not contain its catalog row, as with an existing manager after upgrade.
  f.db.prepare(`UPDATE chat_execution_profiles SET payload_json=json_remove(payload_json,
    '$.policy.toolPermissions.chat_retry_worktree', '$.policy.toolEffects.chat_retry_worktree') WHERE chat_id IN (?,?)`)
    .run('coordinator', assignment.chatId);
  f.db.prepare(`UPDATE chat_outbox SET payload_json=json_remove(payload_json,
    '$.policy.toolPermissions.chat_retry_worktree', '$.policy.toolEffects.chat_retry_worktree') WHERE kind='conversation.report' AND chat_id=?`)
    .run(assignment.chatId);
  await send('coordinator', 'Recover and continue assignment', 'recover-assignment');
  const failed = JSON.parse(toolResult('coordinator', 'check-initial'));
  assert.match(failed.worktree_setup.error, /Dependency setup failed \(exit 2\)/);
  assert.doesNotMatch(JSON.stringify(failed), /fixture secret/);
  assert.equal(JSON.parse(toolResult('coordinator', 'retry-setup')).status, 'ready');
  const worker = f.repository.getChat(assignment.chatId);
  assert.notEqual(path.resolve(worker.worktreeRoot), path.resolve(f.workspace));
  assert.equal(JSON.parse(toolResult('coordinator', 'read-ready')).worktree_setup.status, 'ready');
  const followup = JSON.parse(toolResult('coordinator', 'send-plan'));
  assert.equal(f.repository.getCommand(followup.commandId).command.modelSelection.options.reasoningEffort, 'high');
  const report = JSON.parse(toolResult('coordinator', 'wait-plan'));
  assert.equal(report.command_id, followup.commandId);
  assert.equal(report.assistant_final, 'Here is the plan.');
  assert.equal(f.repository.readTranscript(assignment.chatId).messages.filter(row => row.role === 'user').length, 1);
  await send('peer', 'Read someone else’s assignment', 'denied-peer');
  assert.match(toolResult('peer', 'other-read'), /workspace_denied/);
  const detach = await f.request('/api/chats/' + assignment.chatId + '/workspace', {
    action: 'local', expectedIntentId: worker.workspacePreparation.intent.id, clientRequestId: 'detach-assignment',
  });
  assert.equal(detach.status, 200, JSON.stringify(detach.body));
  await send('coordinator', 'Try to continue on Local', 'denied-local');
  assert.match(toolResult('coordinator', 'detached-send'), /No action was sent to Local/);
  assert.equal(f.repository.listCommands({ chatId: assignment.chatId }).length, 2);
});

test('an existing ordinary chat uses Full access for shell commands after its first Auto turn', { timeout: 20000 }, async t => {
  const commands = [];
  const f = await environment.fixture(t, {
    toolNames: ['execute_command'],
    install: runtime => runtime.setToolHandler('execute_command', ({ args }) => {
      commands.push(args.command);
      return { content: 'Simulated command result' };
    }),
    respond: body => lastUser(body) === 'Push with Full access' && !body.messages.some(row => row.role === 'tool')
      ? [tool('execute_command', { command: 'git push origin main' }, 'test-push')]
      : 'Done.',
  });
  const send = (text, clientRequestId) => f.request('/api/chats/coordinator/commands', { action: 'send', text, clientRequestId });
  const first = await send('Initialize in Auto', 'auto-first');
  assert.equal(first.status, 202);
  await f.runtime.service.idle();
  assert.equal(f.repository.getLatestProfile('coordinator').snapshot.policy.permissionLevel, 'auto');

  f.settings.meta.toolSecurity.permissionLevel = 'full';
  const full = await send('Push with Full access', 'full-second');
  assert.equal(full.status, 202);
  await f.runtime.service.idle();
  assert.equal(f.repository.getCommand(full.body.receipt.commandId).state, 'settled');
  assert.deepEqual(f.repository.listRequests('coordinator'), []);
  assert.deepEqual(commands, ['git push origin main']);
});

test('raw approval deadline expires its live callback and a late answer cannot execute the abandoned operation', { timeout: 20000 }, async t => {
  const f = await environment.fixture(t, { install,
    agentMiddleware: options => agentTransport.createAgentChatToolsMiddleware({ ...options, approvalTimeoutMs: 10 }),
    respond: () => 'Must not run.' });
  f.settings.meta.toolSecurity.permissionLevel = 'manual';
  assert.equal(f.turns.claim('legacy', 'timeout-owner', 'desktop'), true);
  const response = await f.request('/api/chats/agent-commands', { sourceChatId: 'legacy', ownerId: 'timeout-owner',
    toolCallId: 'timeout-call', name: 'chat_stop', args: { chat_id: 'legacy', execution_id: 'stale-turn' } });
  assert.equal(response.status, 409); assert.equal(response.body.error.code, 'request_expired');
  const request = f.repository.listRequests('legacy', null)[0];
  assert.equal(request.state, 'cancelled'); assert.equal(f.runtime.requests.hasLiveWaiter(request.requestId), false);
  const late = await f.request('/api/chats/legacy/requests/' + request.requestId + '/respond',
    { answer: { decision: 'allow_once' }, clientRequestId: 'too-late' });
  assert.equal(late.status, 409);
  assert.equal(f.repository.listCommands({ chatId: 'peer' }).length, 0);
  assert.equal(f.calls.length, 0);
  f.turns.release('legacy', 'timeout-owner');
});

test('a human Stop expires a pending raw approval before the actual bound renderer is released', { timeout: 20000 }, async t => {
  let current;
  const f = await environment.fixture(t, { install, agentMiddleware: agentTransport.createAgentChatToolsMiddleware,
    runtimeOptions: { stopExternalOwner: async ({ chatId, owner }) => {
      current.turns.release(chatId, owner.ownerId);
      return { stopRequested: true };
    } }, respond: () => 'Must not run.' });
  current = f;
  f.settings.meta.toolSecurity.permissionLevel = 'manual';
  assert.equal(f.turns.claim('legacy', 'stopped-owner', 'desktop'), true);
  const pending = f.request('/api/chats/agent-commands', { sourceChatId: 'legacy', ownerId: 'stopped-owner',
    toolCallId: 'stop-call', name: 'chat_stop', args: { chat_id: 'legacy', execution_id: 'stale-turn' } });
  const request = await pendingRequest(f, 'legacy');
  const stopped = await f.request('/api/chats/legacy/commands', { action: 'stop', scope: 'turn',
    expectedLegacyOwnerId: 'stopped-owner', clientRequestId: 'stop-while-asking' });
  assert.equal(stopped.status, 202);
  assert.equal(stopped.body.receipt.result.stopRequested, true);
  assert.equal((await pending).status, 409);
  assert.equal(f.repository.getRequest(request.requestId).state, 'cancelled');
  assert.equal(f.repository.getChat('legacy').chatCommandVersion, undefined);
  assert.equal(f.repository.listCommands({ chatId: 'peer' }).length, 0);
  assert.equal(f.calls.length, 0);
});
