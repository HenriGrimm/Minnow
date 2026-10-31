import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatPolicy } from '../../server/chats/policy.js';
import { createChatRequestService } from '../../server/chats/requests.js';
import { executeConversationTool } from '../../server/chats/conversation-tools.js';
import { validateTodoWriteArgs } from '../../server/runner/todo-write.js';
import { validateProposeModeSwitchArgs } from '../../server/runner/mode-proposal.js';
import { buildChatPreparation } from '../../scripts/build-headless-runner.mjs';

let directory, composer;
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-conversation-tools-'));
  const { outfile } = await buildChatPreparation({ outfile: path.join(directory, 'composer.mjs'), logLevel: 'error' });
  composer = await import(pathToFileURL(outfile).href);
});
after(async () => {
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
function fixture(file = ':memory:') {
  const db = new Database(file); initSessionsSchema(db);
  const repository = createChatRepository({ db });
  repository.createChat({ id: 'chat', name: 'Plan', modeId: 'plan', workspacePath: '/fixture' });
  const fence = repository.claimExecution({ chatId: 'chat', executionId: 'execution', ownerId: 'host' });
  const execution = repository.getExecution('execution');
  const policy = createChatPolicy({ modeId: 'plan', toolPermissions: { todo_write: 'full', propose_mode_switch: 'full', ask_question: 'full' },
    toolEffects: { todo_write: 'external-write', propose_mode_switch: 'external-write', ask_question: 'read' },
    workspaceIds: ['main'], fileWriteScope: 'plans', capabilities: ['execution.host', 'request.respond'] });
  const requests = createChatRequestService({ repository, pollMs: 10, authorizeResponse: (_request, caller) => caller === 'human' });
  const controller = new AbortController();
  const context = { repository, fence, execution, prepared: { policy }, currentPolicy: policy, requests,
    signal: controller.signal, toolCallId: 'tool', now: () => 1000, loadComposer: async () => composer };
  return { db, repository, fence, execution, requests, controller, context,
    run: (name, args) => executeConversationTool(name, args, context) };
}

test('todo_write uses the exact shared coercion and durably updates/clears canonical chat state', async () => {
  const file = path.join(directory, 'todos.sqlite');
  const f = fixture(file);
  const args = { todos: JSON.stringify([{ text: '  Read  ', status: 'done' }, { text: 'Edit', status: 'working' }, { text: 'Test', status: 'active' }]) };
  const expected = validateTodoWriteArgs(args);
  assert.equal(expected.ok, true);
  try {
    const result = JSON.parse((await f.run('todo_write', args)).content);
    assert.deepEqual(result, { progress: '1/3', todos: expected.args.todos });
    assert.deepEqual(f.repository.getChat('chat').todos, expected.args.todos);
    assert.equal(f.repository.getChat('chat').todosUpdatedAt, 1000);
  } finally { f.db.close(); }
  const reopened = new Database(file); const repository = createChatRepository({ db: reopened });
  try {
    assert.deepEqual(repository.getChat('chat').todos, expected.args.todos);
    const execution = repository.getExecution('execution'), fence = repository.getLease('chat');
    const cleared = await executeConversationTool('todo_write', { todos: [] }, { ...f.context, repository, execution, fence });
    assert.deepEqual(JSON.parse(cleared.content), { progress: '0/0', todos: [] });
    assert.equal(repository.getChat('chat').todos, null);
    assert.equal(repository.getChat('chat').todosUpdatedAt, null);
  } finally { reopened.close(); }
});

test('invalid todo input has identical errors and stale fences cannot change state', async () => {
  const f = fixture();
  try {
    assert.equal((await f.run('todo_write', {})).content, validateTodoWriteArgs({}).error);
    assert.equal(f.repository.getChat('chat').todos, undefined);
    await assert.rejects(executeConversationTool('todo_write', { todos: [{ text: 'Changed' }] },
      { ...f.context, fence: { ...f.fence, epoch: f.fence.epoch + 1 } }), error => error.code === 'ownership_conflict');
    assert.equal(f.repository.getChat('chat').todos, undefined);
  } finally { f.db.close(); }
});

test('mode proposal validates the same preset, survives reconnect and never changes mode itself', async () => {
  const f = fixture();
  try {
    const waiting = f.run('propose_mode_switch', { situation: 'implement_in_wrong_mode' });
    await new Promise(resolve => setImmediate(resolve));
    const [request] = f.repository.listRequests('chat');
    assert.equal(request.executionId, 'execution'); assert.equal(request.toolCallId, 'tool');
    assert.deepEqual(request.presentation.question, composer.validateAskQuestionArgs(validateProposeModeSwitchArgs({ situation: 'implement_in_wrong_mode' }).args).args);
    assert.equal(f.repository.getExecution('execution').status, 'waiting_for_input');
    const reconnected = createChatRequestService({ repository: f.repository, authorizeResponse: (_request, caller) => caller === 'human' });
    const answer = { status: 'answered', answers: [{ questionId: 'mode_switch', selectedIds: ['build'], otherText: null }] };
    await reconnected.respond(request.requestId, { answerCommandId: 'answer', answer, context: 'human' });
    assert.deepEqual(JSON.parse((await waiting).content), answer);
    assert.equal(f.repository.getChat('chat').modeId, 'plan');
    assert.equal(f.repository.getExecution('execution').status, 'running');
  } finally { f.db.close(); }
});

test('disabled questions and invalid proposals create no requests, and decline is returned faithfully', async () => {
  const f = fixture();
  try {
    const invalid = await f.run('propose_mode_switch', { situation: 'unknown' });
    assert.equal(invalid.content, validateProposeModeSwitchArgs({ situation: 'unknown' }).error);
    f.context.currentPolicy = createChatPolicy({ ...f.context.prepared.policy,
      toolPermissions: { ...f.context.prepared.policy.toolPermissions, ask_question: 'off' } });
    assert.equal(JSON.parse((await f.run('propose_mode_switch', { situation: 'plan_in_build' })).content).status, 'error');
    assert.deepEqual(f.repository.listRequests('chat'), []);
    f.context.currentPolicy = f.context.prepared.policy;
    const waiting = f.run('propose_mode_switch', { situation: 'plan_in_build' });
    await new Promise(resolve => setImmediate(resolve));
    const [request] = f.repository.listRequests('chat');
    const answer = { status: 'answered', answers: [{ questionId: 'mode_switch', selectedIds: ['stay_build'], otherText: null }] };
    await f.requests.respond(request.requestId, { answerCommandId: 'decline', answer, context: 'human' });
    assert.deepEqual(JSON.parse((await waiting).content), answer);
    assert.equal(f.repository.getChat('chat').modeId, 'plan');
  } finally { f.db.close(); }
});

test('Stop cancels only the current proposal and settles a normal cancelled tool result', async () => {
  const f = fixture();
  try {
    const waiting = f.run('propose_mode_switch', { situation: 'plan_in_build' });
    await new Promise(resolve => setImmediate(resolve));
    const [request] = f.repository.listRequests('chat');
    f.controller.abort(new DOMException('Stopped', 'AbortError'));
    assert.deepEqual(JSON.parse((await waiting).content), { status: 'cancelled', answers: [] });
    assert.equal(f.repository.getRequest(request.requestId).state, 'cancelled');
    assert.equal(f.repository.getChat('chat').modeId, 'plan');
    assert.equal(await f.run('unhandled_tool', {}), null);
  } finally { f.db.close(); }
});

test('mode proposal owns its deadline and late answers cannot resume expired interaction', async () => {
  const f = fixture();
  f.context.askTimeoutMs = 5;
  try {
    const result = await f.run('propose_mode_switch', { situation: 'plan_in_build' });
    assert.equal(JSON.parse(result.content).status, 'error');
    assert.match(JSON.parse(result.content).message, /timed out/);
    const [request] = f.repository.listRequests('chat', null);
    assert.equal(request.state, 'cancelled');
    await assert.rejects(f.requests.respond(request.requestId, { answerCommandId: 'late', answer: 'Build', context: 'human' }),
      error => error.code === 'request_expired');
    assert.equal(f.repository.getExecution('execution').status, 'running');
  } finally { f.db.close(); }
});
