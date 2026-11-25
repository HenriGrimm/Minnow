import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatCaller, createChatProjectRegistry, resolveProjectScope } from '../../server/chats/caller.js';
import { createChatPolicy } from '../../server/chats/policy.js';
import { createChatCommandService } from '../../server/chats/service.js';
import { createChatTranscriptStore } from '../../server/chats/transcript-store.js';
import { createFactoryContinuation } from '../../server/chats/factory-continuation.js';
import { readFactoryCheckpoint } from '../../server/chats/factory-checkpoint.js';
import { formatProcessOutput } from '../../server/process-runner.js';

const chatId = 'factory-chat';
const condition = 'All features and gates pass on the committed tree.';
const intent = { version: 1, skill: { id: 'factory', source: 'slash', input: 'Build two features' }, goalDriven: true };
const feature = id => ({ id, passes: false, checks: ['node --version'], checkPaths: ['factory/checks/' + id] });

async function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'minnow-factory-'));
  const checkout = path.join(dir, 'repo');
  mkdirSync(checkout);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: checkout, windowsHide: true, stdio: 'pipe' });
  git('init', '-b', 'factory/work');
  function write(name, body) {
    mkdirSync(path.dirname(path.join(checkout, name)), { recursive: true });
    writeFileSync(path.join(checkout, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  function commit(title) { git('add', '.'); git('commit', '-m', title); }
  const features = ['F1', 'F2'].map(feature);
  const reviews = [];
  const progress = () => write('factory/progress.json', { branch: 'factory/work', features, reviews });
  progress();
  write('factory/spec.md', 'Build two features');
  write('factory/checks/F1', 'approved check');
  write('factory/factory.json', { gates: [{ command: 'node --version' }], full: [{ command: 'git --version' }] });
  commit('factory: contract');
  const registry = createChatProjectRegistry([{ projectId: 'project', workspaceId: 'checkout', canonicalKey: checkout }]);
  const scope = resolveProjectScope(registry, { projectId: 'project', workspaceKey: checkout });
  const policy = createChatPolicy({ modeId: 'build', workspaceIds: ['checkout'],
    capabilities: ['chat.read', 'chat.send', 'chat.stop', 'execution.host'], toolPermissions: { execute_command: 'full' } });
  const caller = createChatCaller({ actor: 'human', ingress: 'renderer', chatId: 'human', scope, policy });
  const f = { git, write, commit, features, reviews, progress, checkout, dbPath: path.join(dir, 'sessions.sqlite'), now: Date.now };
  async function close() {
    if (!f.db?.open) return;
    await f.controller.dispose();
    await f.service.dispose();
    f.db.close();
  }
  t.after(async () => { await close(); rmSync(dir, { recursive: true, force: true }); });
  async function boot() {
    await close();
    const db = f.db = new Database(f.dbPath);
    db.pragma('foreign_keys=ON'); initSessionsSchema(db);
    const repository = f.repository = createChatRepository({ db });
    if (!db.prepare('SELECT id FROM chats WHERE id=?').get(chatId)) {
      repository.createChat({ id: chatId, name: 'Factory', workspacePath: checkout, providerId: 'provider', modelId: 'model', modeId: 'build' });
    }
    const resolveTarget = async () => ({ chat: repository.getChat(chatId), scope, currentPolicy: policy, policy, registry,
      project: { scope, registry, projectId: scope.projectId }, checkoutIdentity: 'test-checkout' });
    f.service = createChatCommandService({ repository, context: { resolveTarget }, resolveModelSelection: ({ selection }) => selection,
      captureTurnIntent: async intent => ({ intent, skillBody: 'Factory lead snapshot', skillGoal: condition }) });
    f.controller = createFactoryContinuation({ repository, resolveTarget, isBusy: () => repository.getLease(chatId)?.state === 'active',
      changed() {}, now: () => f.now(), kick: id => f.service.kick(id), pollMs: 60000 });
    await f.service.recoverExecutions(() => ({ verified: true, source: 'fixture/no-runtime-processes', checkedAt: Date.now() }));
    f.controller.start();
    await f.controller.notify(chatId);
    await f.service.kick(chatId);
  }
  f.boot = boot;
  f.close = close;
  f.stop = () => f.service.stop(caller, { chatId, clientRequestId: 'user-stop' });
  f.start = async () => {
    const result = await f.service.send(caller, { chatId, clientRequestId: 'explicit-factory', message: '/factory Build two features', intent });
    await f.service.kick(chatId);
    return result.commandId;
  };
  f.run = () => f.repository.getChat(chatId).factoryRun;
  f.tick = async () => { await Promise.all(Array.from({ length: 8 }, () => f.controller.notify(chatId))); await f.service.kick(chatId); };
  f.commands = () => f.repository.listCommands({ chatId }).filter(row => row.command.kind === 'send');
  f.settle = (id, { verdict = 'Done', checks = [], status = 'completed', error = null } = {}) => {
    const r = f.repository, executionId = 'exec-' + id;
    r.createExecution({ executionId, commandId: id, chatId });
    const fence = r.claimExecution({ chatId, executionId, ownerId: 'host', kind: 'server' });
    r.updateCommand(id, { state: 'running', executionId });
    createChatTranscriptStore({ repository: r, chatId, fence }).append(chatId, { role: 'assistant', content: verdict });
    for (const [i, [command, code]] of checks.entries()) {
      const invocationId = 'check-' + id + '-' + i;
      r.recordToolIntent({ chatId, executionId, invocationId, toolCallId: 'tool-' + i, toolName: 'execute_command', input: { command, cwd: '.' } }, { fence });
      r.settleToolInvocation(invocationId, { content: formatProcessOutput(command, { code, stdout: '', stderr: '' }) }, { fence });
    }
    if (status === 'recovery_required') r.recordToolIntent({ chatId, executionId, invocationId: 'interrupted-effect',
      toolCallId: 'unknown-outcome', toolName: 'execute_command', input: { command: 'git commit' } }, { fence });
    r.updateExecution(executionId, { status, result: {} }, { fence });
    r.updateCommand(id, { state: status === 'completed' ? 'settled' : 'failed', error });
    if (status !== 'recovery_required') r.releaseLease(chatId, fence);
    return fence;
  };
  await boot();
  return f;
}

test('server restart at a feature, queued continuation and final verdict resumes exactly once without a window', async t => {
  const f = await fixture(t);
  const origin = await f.start();
  assert.equal(f.run().id, origin);
  assert.equal(await f.start(), origin, 'lost admission receipt');
  f.features[0].passes = true; f.progress(); f.commit('factory: F1'); f.settle(origin);
  await f.boot();
  const build = f.repository.getCommand(f.run().cursor);
  assert.match(build.command.message, /first unfinished feature F2/);
  assert.match(build.command.message, /Build two features/);
  assert.equal(build.captured.turnIntent.skillBody, 'Factory lead snapshot');
  assert.equal(build.command.provenance.actor, 'system');
  assert.equal(build.captured.factoryAssignment.id, 'F2');
  assert.equal(build.command.intent.suppressUserEcho, true);
  await f.boot(); await f.tick();
  assert.equal(f.commands().length, 2);
  f.features[1].passes = true; f.reviews.push({ afterFeature: 'F2' }); f.progress(); f.write('factory/REPORT.md', 'Both features passed.\n## How to run\nRun the command.\n## Next steps\nNone.'); f.commit('factory: report'); f.settle(build.commandId);
  await f.tick();
  const verify = f.repository.getCommand(f.run().cursor);
  assert.equal(verify.captured.factoryPhase, 'verify');
  f.settle(verify.commandId, { verdict: 'Checked the contract.\nYES', checks: [['node --version', 0], ['git --version', 0]] });
  await f.boot(); await f.tick();
  assert.equal(f.repository.getChat(chatId).activeGoal.achieved, true, f.run().reason);
  assert.equal(f.commands().length, 3);
  await f.boot(); assert.equal(f.commands().length, 3);
  const messages = f.repository.readTranscript(chatId).messages;
  assert.match(messages.at(-1).content, /Factory complete[\s\S]*How to run/);
  assert.equal(messages.filter(m => m.messageId?.startsWith('report-')).length, 1);
});

test('uncertain effects, Stop and Clear survive restart until explicitly resolved', async t => {
  const f = await fixture(t), origin = await f.start();
  f.settle(origin, { status: 'recovery_required' });
  await f.boot(); await f.tick();
  assert.match(f.run().reason, /interrupted tool/);
  assert.equal(f.commands().length, 1);
  f.repository.advanceCancellationEpoch(chatId);
  await f.boot(); assert.equal(f.repository.getChat(chatId).activeGoal.paused, true);
  f.controller.control(chatId, origin, 'clear');
  await f.boot(); await f.tick();
  assert.equal(f.repository.getChat(chatId).activeGoal, undefined);
  assert.equal(f.commands().length, 1);
});

test('wrong branch holds an admitted continuation and returning to the checkout allows one execution', async t => {
  const f = await fixture(t), origin = await f.start();
  f.settle(origin); await f.tick();
  const id = f.run().cursor;
  f.git('switch', '-c', 'other');
  await f.boot();
  let calls = 0;
  f.service.registerHost({ id: 'fake-host', kind: 'server', execute: async () => { calls++; return { outcome: 'completed' }; } });
  await f.tick(); assert.equal(calls, 0); assert.equal(f.repository.getCommand(id).error.code, 'workspace_denied');
  f.git('switch', 'factory/work');
  await f.tick(); assert.equal(calls, 1);
});

test('verification demands the last successful exit for every check and preserves frozen checks', async t => {
  const f = await fixture(t);
  f.features.forEach(row => row.passes = true); f.reviews.push({ afterFeature: 'F2' }); f.progress(); f.write('factory/REPORT.md', 'Done.\n## How to run\nRun the command.\n## Next steps\nNone.'); f.commit('factory: report');
  f.write('factory/checks/F1', 'altered'); f.commit('unapproved change');
  assert.match((await readFactoryCheckpoint(f.checkout)).reason, /frozen checks/);
  f.write('factory/checks/F1', 'approved check'); f.commit('restore check');
  const origin = await f.start(); f.settle(origin); await f.tick();
  const id = f.run().cursor;
  f.settle(id, { verdict: 'YES', checks: [['node --version', 0], ['git --version', 0], ['git --version', 1]] });
  await f.tick();
  assert.equal(f.run().status, 'active'); assert.equal(f.run().phase, 'build');
  assert.match(f.repository.getCommand(f.run().cursor).command.message, /verification did not pass/);
});

test('startup recovers after the writer process exits mid-turn, preserves partial edits, and continues from the last commit', async t => {
  const f = await fixture(t), id = await f.start();
  f.features[0].passes = true; f.progress(); f.commit('factory: F1');
  const executionId = 'interrupted-writer';
  await f.close();
  const writer = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/factory-interrupted-writer.mjs', import.meta.url)),
    f.dbPath, chatId, id, executionId, f.checkout], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(writer.status, 23, writer.stderr);
  await f.boot();
  assert.equal(f.repository.getExecution(executionId).result.failure.quiescence.verified, true);
  assert.match(f.repository.getCommand(f.run().cursor).command.message, /first unfinished feature F2/);
  assert.match(f.git('status', '--short').toString(), /unfinished.txt/);
  await f.boot(); assert.equal(f.commands().length, 2);
});

test('explicit Stop holds the queue across restarts and Resume releases only one new turn', async t => {
  const f = await fixture(t), id = await f.start();
  f.settle(id); await f.tick();
  const queued = f.run().cursor;
  await f.stop(); await f.boot();
  assert.equal(f.run().status, 'paused'); assert.equal(f.repository.getCommand(queued).held, true);
  f.controller.control(chatId, id, 'resume'); await f.tick(); await f.boot();
  assert.equal(f.run().status, 'active'); assert.equal(f.repository.getCommand(queued).state, 'cancelled');
  assert.equal(f.commands().length, 3);
});

test('older managed goals are adopted from their human slash receipt and keep the original request', async t => {
  const f = await fixture(t), id = await f.start();
  f.settle(id);
  f.db.prepare("UPDATE chat_conversation_state SET meta_json=json_remove(meta_json,'$.factoryRun') WHERE chat_id=?").run(chatId);
  f.db.prepare("UPDATE chats SET meta_json=json_remove(meta_json,'$.activeGoal.factoryRunId') WHERE id=?").run(chatId);
  await f.boot();
  assert.equal(f.run().id, id);
  assert.match(f.repository.getCommand(f.run().cursor).command.message, /Build two features/);
  await f.boot(); assert.equal(f.commands().length, 2);
});

test('retry deadlines survive a restart and an offline provider can come back without input', async t => {
  const f = await fixture(t), id = await f.start();
  f.settle(id, { status: 'failed', error: { code: 'model_unavailable', message: 'Model unavailable', retryable: true } });
  await f.tick();
  const deadline = f.run().retryAt;
  assert.ok(deadline > Date.now());
  await f.boot(); assert.equal(f.run().retryAt, deadline);
  assert.equal(f.commands().length, 1);
  f.now = () => deadline + 1;
  await f.tick(); assert.equal(f.commands().length, 2);
});

test('setup recovery uses the original request before any contract has been committed', async t => {
  const f = await fixture(t);
  f.git('switch', '--orphan', 'factory/setup');
  f.write('factory/spec.md', 'Partial specification');
  const id = await f.start(); f.settle(id);
  await f.boot();
  const next = f.repository.getCommand(f.run().cursor);
  assert.match(next.command.message, /unfinished setup or contract step/);
  assert.match(next.command.message, /Build two features/);
  assert.match(f.git('status', '--short').toString(), /factory/);
});

test('a crash between the fifth feature and its review resumes the review before starting F6', async t => {
  const f = await fixture(t);
  f.features.push(...['F3', 'F4', 'F5', 'F6'].map(feature));
  for (const item of f.features.slice(0, 5)) item.passes = true;
  f.progress(); f.commit('factory: F5');
  const id = await f.start(); f.settle(id); await f.boot();
  assert.match(f.repository.getCommand(f.run().cursor).command.message, /review checkpoint after F5/);
  f.reviews.push({ afterFeature: 'F5' }); f.progress(); f.commit('factory: review after F5');
  f.settle(f.run().cursor); await f.boot();
  assert.match(f.repository.getCommand(f.run().cursor).command.message, /first unfinished feature F6/);
});

test('switching models wakes a quota-paused factory across a restart and preserves the checkpoint', async t => {
  const f = await fixture(t), id = await f.start();
  f.settle(id, { status: 'failed', error: { code: 'model_unavailable', message: 'Provider usage limit reached (402)' } });
  await f.tick(); assert.equal(f.run().status, 'paused');
  await f.boot(); assert.equal(f.commands().length, 1);
  f.repository.configureChat(chatId, { providerId: 'replacement', modelId: 'available' });
  await f.boot();
  assert.equal(f.run().status, 'active');
  const next = f.repository.getCommand(f.run().cursor);
  assert.equal(next.command.modelSelection.providerId, 'replacement');
  assert.equal(next.command.modelSelection.modelId, 'available');
  assert.equal(next.captured.factoryAssignment.id, 'F1');
});

test('a documented amendment can ratify an existing check without rewriting it and only covers those bytes', async t => {
  const f = await fixture(t);
  f.features.forEach(row => row.passes = true); f.reviews.push({ afterFeature: 'F2' }); f.progress();
  f.write('factory/REPORT.md', '## How to run\nRun the app.\n## Follow-ups\nNone.');
  f.write('factory/checks/F2', 'new regression check'); f.commit('factory: feature repair');
  assert.match((await readFactoryCheckpoint(f.checkout)).reason, /factory\/checks\/F2/);
  f.write('factory/decisions.md', 'D4: F2 adds missing regression coverage; the original acceptance test remains.');
  f.git('add', 'factory/decisions.md');
  f.git('commit', '-m', 'factory: amend F2 coverage', '-m', 'Factory-Check: factory/checks/F2');
  assert.equal((await readFactoryCheckpoint(f.checkout)).ready, true);
  f.write('factory/checks/F2', 'weakened'); f.commit('later edit');
  assert.match((await readFactoryCheckpoint(f.checkout)).reason, /factory\/checks\/F2/);
});

test('startup delivers a missing report for an already verified run without a model turn', async t => {
  const f = await fixture(t);
  const origin = await f.start();
  f.features.forEach(row => row.passes = true); f.reviews.push({ afterFeature: 'F2' }); f.progress();
  f.write('factory/REPORT.md', '## How to run\nRun the app.\n## Next steps\nInstall the app.'); f.commit('factory: report');
  f.settle(origin); await f.tick();
  f.settle(f.run().cursor, { verdict: 'YES', checks: [['node --version', 0], ['git --version', 0]] });
  f.db.prepare("UPDATE chat_conversation_state SET meta_json=json_set(meta_json,'$.factoryRun.status','achieved') WHERE chat_id=?").run(chatId);
  await f.boot(); await f.boot();
  assert.equal(f.commands().length, 2);
  assert.equal(f.repository.readTranscript(chatId).messages.filter(row => row.messageId === 'report-' + origin).length, 1);
  assert.match(f.repository.readTranscript(chatId).messages.at(-1).content, /Install the app/);
});
