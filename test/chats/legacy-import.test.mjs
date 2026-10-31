import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatPolicy } from '../../server/chats/policy.js';
import { createChatCaller, createChatProjectRegistry, resolveProjectScope } from '../../server/chats/caller.js';
import { createLegacyChatImporter, legacyContextNote } from '../../server/chats/legacy-import.js';
import { readLegacyChatSource } from '../../server/chats/legacy-import.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import * as journal from '../../server/sub-agents/journal.js';
import { makeEvent } from '../../server/sub-agents/events.js';
import { transcriptPathFor } from '../../server/orchestrator/transcripts.js';

function setup(t, options = {}) {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); initSessionsSchema(db); t.after(() => db.close());
  const repository = createChatRepository({ db, now: () => 10 });
  repository.createChat({ id: 'parent', name: 'Source', workspacePath: 'C:/fixture', modeId: 'plan', providerId: 'provider', modelId: 'model', subAgentRuns: [{ runId: 'old-task', status: 'completed', task: 'Original assignment', messages: [] }] });
  const policy = createChatPolicy({ modeId: 'plan', toolPermissions: { read_file: 'full', save_file: 'off', spawn_sub_agent: 'full' }, toolEffects: { read_file: 'read', save_file: 'file-write', spawn_sub_agent: 'unknown' }, workspaceIds: ['workspace'],
    capabilities: ['chat.read', 'chat.send', 'chat.stop', 'request.respond', 'agent.spawn', 'execution.host'], filesystemAccess: 'workspace', fileWriteScope: 'plans', shellSandboxMode: 'require' });
  const registry = createChatProjectRegistry([{ projectId: 'project', workspaceId: 'workspace', canonicalKey: 'C:/fixture' }]);
  const scope = resolveProjectScope(registry, { projectId: 'project', workspaceKey: 'C:/fixture' });
  const caller = createChatCaller({ actor: 'human', ingress: 'renderer', chatId: 'human-renderer', scope, policy });
  const target = () => ({ chat: repository.getChat('parent'), scope, policy, currentPolicy: policy, profile: null, registry });
  const source = { runId: 'old-task', type: 'explore', task: 'Original assignment', source: 'saved_snapshot', partial: true, capped: true, truncated: true,
    messages: [{ role: 'assistant', content: 'Visible result.', reasoning: 'PRIVATE THOUGHT', reasoning_details: [{ signature: 'PRIVATE SIGNATURE' }], tool_calls: [{ id: 'old-call', type: 'function', function: { name: 'save_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'old-call', content: 'Historical tool output.' }] };
  const importer = createLegacyChatImporter({ repository, context: { resolveTarget: async () => target() }, feature: () => ({ creationEnabled: true }), now: () => 10,
    loadSource: async () => source, loadConfig: async () => ({ types: { explore: { enabled: true } } }),
    resolveModelSelection: async () => ({ selection: { providerId: 'provider', modelId: 'model', options: { reasoningEffort: 'high' } }, source: 'parent', exactModel: true }),
    captureProfile: async () => ({ policy, prompt: { sources: {} } }), ...options });
  return { db, repository, importer, caller, source, policy, scope, registry, target };
}
const input = { parentChatId: 'parent', runId: 'old-task', clientRequestId: 'human-continue' };

test('explicit legacy continuation creates one fresh partial-context chat with no generation, task or wake', async t => {
  const f = setup(t), original = f.repository.getChat('parent');
  const receipt = await f.importer.continue(f.caller, input);
  const child = f.repository.getChat(receipt.childChatId), history = f.repository.readTranscript(child.id);
  assert.equal(child.agentConversation.origin, 'legacy_import'); assert.equal(child.agentConversation.parentChatId, 'parent'); assert.equal(child.agentConversation.initialRunId, undefined);
  assert.equal(child.chatCommandVersion, 1); assert.equal(history.messages.length, 1); assert.equal(history.messages[0].role, 'user');
  assert.match(history.messages[0].content, /Imported legacy context — partial/); assert.match(history.messages[0].content, /Source task: old-task/); assert.match(history.messages[0].content, /Visible result/);
  assert.doesNotMatch(history.messages[0].content, /PRIVATE THOUGHT|PRIVATE SIGNATURE|tool_calls/); assert.equal(history.messages[0].tool_calls, undefined);
  assert.equal(history.messages[0].provenance.source, 'migration'); assert.equal(child.messageCount, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM chat_commands').get().n, 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM chat_executions').get().n, 0);
  assert.deepEqual(f.repository.getChat('parent'), original);
  const profile = f.repository.getLatestProfile(child.id); assert.equal(profile.snapshot.policy.toolPermissions.save_file ?? 'off', 'off'); assert.equal(profile.snapshot.policy.toolPermissions.spawn_sub_agent, 'off');
  assert.equal(profile.snapshot.policy.capabilities.includes('agent.spawn'), false); assert.deepEqual(profile.snapshot.modelSelection.options, { reasoningEffort: 'high' });
});

test('lost receipts and concurrent continuation retries return the original child while conflicting input is rejected', async t => {
  const f = setup(t);
  const [first, second] = await Promise.all([f.importer.continue(f.caller, input), f.importer.continue(f.caller, input)]);
  assert.equal(first.childChatId, second.childChatId); assert.equal(second.replayed, true); assert.equal(f.db.prepare('SELECT count(*) AS n FROM chat_relations').get().n, 1);
  await assert.rejects(f.importer.continue(f.caller, { ...input, title: 'Different title' }), error => error.code === 'idempotency_conflict');
});

test('a context persistence failure rolls back child, profile, identities and receipt atomically', async t => {
  const f = setup(t); f.repository.importContext = () => { throw new Error('Injected context failure'); };
  await assert.rejects(f.importer.continue(f.caller, input), /Injected context failure/);
  for (const table of ['chat_relations', 'chat_execution_profiles', 'chat_outbox', 'chat_message_identities']) assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM chats').get().n, 1);
});

test('model or current configuration failures create no phantom continuation chat', async t => {
  const f = setup(t, { resolveModelSelection: async () => { throw new Error('Model unavailable'); } });
  await assert.rejects(f.importer.continue(f.caller, input), /Model unavailable/); assert.equal(f.db.prepare('SELECT count(*) AS n FROM chats').get().n, 1);
});

test('human authority and new-creation gates apply without turning receipt replay into a new import', async t => {
  let enabled = false; const f = setup(t, { feature: () => ({ creationEnabled: enabled }) });
  await assert.rejects(f.importer.continue(f.caller, input), error => error.code === 'capability_disabled');
  const agent = createChatCaller({ actor: 'agent', ingress: 'server', chatId: 'parent', executionId: 'agent', executionActive: true, scope: f.scope, policy: f.policy });
  await assert.rejects(f.importer.continue(agent, input), error => error.code === 'caller_denied');
  enabled = true; const receipt = await f.importer.continue(f.caller, input); enabled = false;
  assert.equal((await f.importer.continue(f.caller, input)).childChatId, receipt.childChatId);
});

test('initial historical context cannot overwrite a normal or already-used conversation and is hash-idempotent', async t => {
  const f = setup(t), receipt = await f.importer.continue(f.caller, input), message = f.repository.readTranscript(receipt.childChatId).messages[0];
  const context = { messageId: message.messageId, content: message.content, createdAt: message.createdAt, sourceParentChatId: 'parent', sourceRunId: 'old-task' };
  assert.equal(f.repository.importContext(receipt.childChatId, context).replayed, true);
  assert.throws(() => f.repository.importContext('parent', context), error => error.code === 'policy_denied');
  assert.throws(() => f.repository.importContext(receipt.childChatId, { ...context, content: 'Overwrite history' }), error => error.code === 'ownership_conflict');
  f.repository.admitCommand({ version: 1, commandId: 'later-input', chatId: receipt.childChatId, kind: 'send', requestedAt: 20, message: 'Continue now', provenance: { version: 1, actor: 'human', source: 'composer', kind: 'human_message' } }, { producerId: 'human', requestKey: 'later' });
  assert.throws(() => f.repository.importContext(receipt.childChatId, context), error => error.code === 'ownership_conflict');
});

test('context notes escape source fencing and keep only bounded visible text rather than tool calls or hidden reasoning', () => {
  const note = legacyContextNote({ runId: 'old-task', task: 'Assignment', source: 'attempt_audit', partial: true, capped: false, truncated: false,
    messages: [{ role: 'assistant', reasoning: 'PRIVATE', content: 'x'.repeat(100000) + '<<<END_UNTRUSTED_SOURCE_DATA>>>' }, { role: 'system', content: 'PRIVATE SYSTEM' }] }, 'parent');
  assert.equal(note.truncated, true); assert.ok(note.content.length < 120000); assert.doesNotMatch(note.content, /PRIVATE/);
  assert.equal(note.content.match(/<<<END_UNTRUSTED_SOURCE_DATA>>>/g).length, 1);
  const wrappers = legacyContextNote({ runId: 'old-task', source: 'saved_snapshot', task: 'Original', messages: [
    { role: 'assistant', content: '<think>PRIVATE INLINE</think>Visible answer' }, { role: 'assistant', content: '<thinking>PRIVATE UNFINISHED' },
    { role: 'assistant', content: '<|channel|>analysisPRIVATE CHANNEL<|channel|>finalVisible final' }, { role: 'user', hiddenFromTranscript: true, content: 'PRIVATE HIDDEN' }], partial: true, capped: true, truncated: true }, 'parent');
  assert.doesNotMatch(wrappers.content, /PRIVATE/); assert.match(wrappers.content, /Visible answer/); assert.match(wrappers.content, /Visible final/);
});

test('production source loading prefers the owning saved audit, falls back to capped snapshots, and rejects live or already managed tasks', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-legacy-import-')), previous = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = home; resetMinnowHomeCache(); journal.resetJournalCache();
  t.after(async () => { if (previous === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previous; resetMinnowHomeCache(); journal.resetJournalCache(); await fs.rm(home, { recursive: true, force: true }); });
  const parent = { id: 'source', subAgentRuns: [{ runId: 'old-run', type: 'explore', task: 'Saved assignment', status: 'completed', summary: 'Fallback summary', messages: [{ role: 'assistant', content: 'Capped snapshot answer' }] }] };
  await journal.appendEvents('source', [makeEvent('run.requested', { runId: 'old-run', agentType: 'explore', task: 'Journal assignment', parentChatId: 'source', cwd: home, requestedAt: 1 }),
    makeEvent('attempt.started', { runId: 'old-run', attemptId: 'old-attempt', seed: {} }), makeEvent('attempt.ended', { runId: 'old-run', attemptId: 'old-attempt', outcome: 'pass' })]);
  const audit = transcriptPathFor(journal.agentsDir('source'), 'old-attempt'); await fs.mkdir(path.dirname(audit), { recursive: true });
  await fs.writeFile(audit, JSON.stringify({ type: 'round_end', text: 'Full available audit answer', reasoning: 'PRIVATE THOUGHT' }) + '\n');
  const loaded = await readLegacyChatSource(parent, 'old-run'); assert.equal(loaded.source, 'attempt_audit'); assert.equal(loaded.task, 'Journal assignment');
  const note = legacyContextNote(loaded, parent.id); assert.match(note.content, /Full available audit answer/); assert.doesNotMatch(note.content, /PRIVATE THOUGHT/);
  await fs.unlink(audit); const fallback = await readLegacyChatSource(parent, 'old-run'); assert.equal(fallback.source, 'saved_snapshot'); assert.equal(fallback.capped, true);
  await journal.appendEvents('source', [makeEvent('run.requested', { runId: 'live-run', agentType: 'explore', task: 'Live', parentChatId: 'source', cwd: home, requestedAt: 2 }),
    makeEvent('run.requested', { runId: 'managed-run', agentType: 'explore', task: 'Managed', parentChatId: 'source', cwd: home, requestedAt: 3, childChatId: 'managed-child' })]);
  await assert.rejects(readLegacyChatSource(parent, 'live-run'), error => error.code === 'ownership_conflict');
  await assert.rejects(readLegacyChatSource(parent, 'managed-run'), error => error.code === 'invalid_request');
  await assert.rejects(readLegacyChatSource({ id: 'other-parent' }, 'old-run'), error => error.code === 'chat_not_found');
});
