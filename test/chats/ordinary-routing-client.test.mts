import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createEmptyChatObject, resetSessionPersistenceForTests, setSessionStateForTests } from '../../src/state/sessions.ts';
import { ordinaryChatEligibility, ensureOrdinaryChatRoute, resetOrdinaryChatRoutingForTests } from '../../src/chat/ordinary-routing.ts';
import { readOrdinaryChatExecutionCapability, setAgentConversationsCapabilityForTests } from '../../src/config/agent-conversations-enabled.ts';
import { setPairedDevice } from '../../src/api/session-token.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { sendProgrammaticChatText } from '../../src/chat/messaging.ts';

Object.assign(globalThis, { sessionStorage: window.sessionStorage });
const realFetch = globalThis.fetch;
const feature = { version: 1, capability: 'ordinaryChatExecutionV1', admissionEnabled: true, promotionEnabled: true,
  recoveryEnabled: true, reason: 'released', blockers: [] } as const;
const capabilities = { version: 1, capability: 'agentConversationsV1', creationEnabled: true, recoveryEnabled: true, reason: 'released',
  conversationStorage: 'sqlite', ordinaryExecution: feature, clientProtocol: { version: 1, minReaderVersion: 1, minWriterVersion: 1 } };
const local = { serverStorage: true, pairedDevice: false, busy: false };
function chat() {
  const value = createEmptyChatObject('model', 'C:/project'); value.id = 'ordinary'; value.modeId = 'build'; value.providerId = 'provider';
  setSessionStateForTests({ version: 6, activeId: value.id, sidebarCollapsed: false, chats: [value] });
  return value;
}
afterEach(() => {
  globalThis.fetch = realFetch; resetOrdinaryChatRoutingForTests(); resetSessionPersistenceForTests(); setSessionStateForTests(null);
  setStorageModeForTests(null); setPairedDevice(false); setAgentConversationsCapabilityForTests(); sessionStorage.clear();
});

test('only a complete modern SQLite ordinary capability enables new admission; malformed, contradictory and old hosts fail closed', () => {
  assert.deepEqual(readOrdinaryChatExecutionCapability(capabilities), feature);
  for (const body of [null, {}, { ...capabilities, conversationStorage: 'json' }, { ...capabilities, clientProtocol: undefined },
    { ...capabilities, clientProtocol: { version: 2, minReaderVersion: 1, minWriterVersion: 1 } },
    { ...capabilities, ordinaryExecution: { ...feature, blockers: ['unverified_gate'] } },
    { ...capabilities, ordinaryExecution: { ...feature, recoveryEnabled: false } },
    { ...capabilities, ordinaryExecution: { ...feature, admissionEnabled: 'yes' } },
    { ...capabilities, ordinaryExecution: { ...feature, reason: 'disabled' } },
    { ...capabilities, ordinaryExecution: { ...feature, blockers: [null] } }]) assert.equal(readOrdinaryChatExecutionCapability(body), null);
});

test('eligibility distinguishes new and idle roots, rejects active/observer/unsupported scope, and never downgrades canonical chats', () => {
  const value = chat();
  assert.equal(ordinaryChatEligibility(value, feature, local).reason, 'new_root');
  value.history = [{ role: 'user', content: 'Saved' }];
  assert.equal(ordinaryChatEligibility(value, feature, local).reason, 'idle_root');
  assert.equal(ordinaryChatEligibility(value, { ...feature, promotionEnabled: false }, local).eligible, false);
  assert.equal(ordinaryChatEligibility(value, feature, { ...local, busy: true }).reason, 'legacy_owner_active');
  assert.equal(ordinaryChatEligibility(value, feature, { ...local, pairedDevice: true }).reason, 'observer_only');
  value.resumeInterrupted = true;
  assert.equal(ordinaryChatEligibility(value, feature, local).reason, 'legacy_recovery_required');
  value.chatCommandVersion = 1;
  assert.equal(ordinaryChatEligibility(value, null, { serverStorage: false, pairedDevice: true, busy: true }).route, 'server');
});

test('rollback and old storage never start promotion for an unadmitted root; a canonical root remains a command client', async () => {
  const value = chat(); setStorageModeForTests('server');
  setAgentConversationsCapabilityForTests({ ...capabilities, ordinaryExecution: { ...feature, admissionEnabled: false, promotionEnabled: false, reason: 'disabled' } });
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('must not reach admission'); };
  assert.equal(await ensureOrdinaryChatRoute(value), 'legacy'); assert.equal(calls, 0);
  value.chatCommandVersion = 1;
  assert.equal(await ensureOrdinaryChatRoute(value), 'server'); assert.equal(calls, 0);
});

test('detached unadmitted chats retain Local and rollback setup guards while eligible promotion still fences identity', async () => {
  const current = chat(), detached = JSON.parse(JSON.stringify(current));
  detached.worktreeSetupRequired = true;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('must not dispatch'); };
  setStorageModeForTests('localStorage');
  assert.equal(await ensureOrdinaryChatRoute(detached), 'legacy');
  await assert.rejects(sendProgrammaticChatText(detached, 'Change a file'), /Retry worktree setup/);
  setStorageModeForTests('server');
  setAgentConversationsCapabilityForTests({ ...capabilities, ordinaryExecution: { ...feature, admissionEnabled: false, promotionEnabled: false, reason: 'disabled' } });
  assert.equal(await ensureOrdinaryChatRoute(detached), 'legacy');
  await assert.rejects(sendProgrammaticChatText(detached, 'Change a file'), /Retry worktree setup/);
  assert.equal(detached.history.length, 0);
  setAgentConversationsCapabilityForTests(capabilities);
  await assert.rejects(ensureOrdinaryChatRoute(detached), /conversation changed while checking server routing/);
  assert.equal(calls, 0);
  assert.equal(sessionStorage.getItem(`minnow.ordinaryPromotion.${detached.id}`), null);
});

test('uncertain promotion survives renderer reload and rollout rollback without falling through to legacy execution', async () => {
  const value = chat();
  sessionStorage.setItem(`minnow.ordinaryPromotion.${value.id}`, JSON.stringify({ id: 'lost-receipt', revision: 7 }));
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++; assert.deepEqual(JSON.parse(String(init?.body)), { clientRequestId: 'lost-receipt', expectedRevision: 7 });
    throw new TypeError('connection closed after admission');
  };
  await assert.rejects(ensureOrdinaryChatRoute(value), /connection closed/); assert.equal(calls, 2);
  resetOrdinaryChatRoutingForTests();
  const payloads: any[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), '/api/chats/ordinary/ordinary-routing');
    payloads.push(JSON.parse(String(init?.body)));
    return Response.json({ receipt: { chatId: value.id, revision: 8, disposition: 'promoted' },
      frame: { chatId: value.id, fields: { chatCommandVersion: 1, composerDraft: 'Do not replace this viewer draft' } } });
  };
  value.composerDraft = 'Current window draft';
  assert.deepEqual(await Promise.all([ensureOrdinaryChatRoute(value), ensureOrdinaryChatRoute(value)]), ['server', 'server']);
  assert.equal(payloads.length, 1); assert.equal(payloads[0].clientRequestId, 'lost-receipt');
  assert.equal(value.chatCommandVersion, 1); assert.equal(value.composerDraft, 'Current window draft');
  assert.equal(sessionStorage.getItem(`minnow.ordinaryPromotion.${value.id}`), null);
});

test('incomplete successful promotion cannot send a model message, clear the draft or choose a renderer fallback', async () => {
  const value = chat(); value.composerDraft = 'Keep';
  sessionStorage.setItem(`minnow.ordinaryPromotion.${value.id}`, JSON.stringify({ id: 'incomplete', revision: 7 }));
  const urls: string[] = [];
  globalThis.fetch = async url => { urls.push(String(url)); return Response.json({ receipt: { chatId: value.id, disposition: 'promoted', revision: 8 } }); };
  await assert.rejects(sendProgrammaticChatText(value, 'Keep'), /receipt is incomplete/);
  assert.equal(value.composerDraft, 'Keep'); assert.equal(value.chatCommandVersion, undefined);
  assert.deepEqual(urls, ['/api/chats/ordinary/ordinary-routing']);
  assert.ok(sessionStorage.getItem(`minnow.ordinaryPromotion.${value.id}`));
});


test('real send flushes its legacy shell, promotes at the saved revision, then admits through the server without a renderer generation', async t => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path'), http = await import('node:http');
  const { getSessionsDb, closeSessionsDb } = await import('../../server/config/sessions-db.js');
  const { resetMinnowHomeCache } = await import('../../server/config/home.js');
  const { createConfigMiddleware } = await import('../../server/config/middleware.js');
  const { createChatMiddleware } = await import('../../server/chats/middleware.js');
  const { createChatRepository } = await import('../../server/chats/repository.js');
  const { createChatCommandService } = await import('../../server/chats/service.js');
  const { createChatPresentation } = await import('../../server/chats/presentation.js');
  const { createChatPolicy } = await import('../../server/chats/policy.js');
  const { createChatCaller, createChatProjectRegistry, resolveProjectScope } = await import('../../server/chats/caller.js');
  const { loadSessionsFromStorage, findChatById } = await import('../../src/state/sessions.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-route-send-')), prior = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = root; resetMinnowHomeCache();
  const db = getSessionsDb(), repository = createChatRepository({ db });
  const registry = createChatProjectRegistry([{ projectId: 'project', workspaceId: 'workspace', canonicalKey: root }]);
  const scope = resolveProjectScope(registry, { projectId: 'project', workspaceKey: root });
  const policy = createChatPolicy({ modeId: 'build', workspaceIds: ['workspace'], capabilities: ['chat.read', 'chat.send', 'chat.stop', 'execution.host'], toolPermissions: {} });
  const caller = createChatCaller({ actor: 'human', ingress: 'renderer', chatId: 'human', scope, policy });
  const context: any = { resolveTarget: async (chatId: string) => ({ chat: repository.getChat(chatId), scope, policy, currentPolicy: policy, registry, profile: repository.getLatestProfile(chatId) }),
    humanCaller: async (chatId: string) => ({ caller, target: await context.resolveTarget(chatId) }) };
  repository.createChat({ id: 'ordinary', name: 'New root', workspacePath: root, providerId: 'provider', modelId: 'model', modeId: 'build' });
  db.prepare('DELETE FROM chat_conversation_state WHERE chat_id=?').run('ordinary');
  const presentation = createChatPresentation({ repository });
  const service = createChatCommandService({ repository, context,
    resolveModelSelection: ({ selection }: any) => selection,
    captureProfile: ({ target, selection }: any) => ({ profileId: 'profile-' + target.chat.id, profileVersion: 1, snapshot: { policy, modelSelection: selection } }) });
  let executions = 0;
  service.registerHost({ id: 'server', kind: 'server', execute: async ({ command, fence }: any) => {
    executions++;
    repository.appendMessage(command.chatId, { role: 'user', content: command.message }, { fence, messageId: 'input-' + command.commandId });
    return { outcome: 'no_report' };
  } });
  const config = createConfigMiddleware(), chats = createChatMiddleware({ getRuntime: () => ({ service, context, repository, presentation }) });
  const server = http.createServer((req: any, res) => { req.minnowAuth = { kind: 'host' }; void chats(req, res, () => config(req, res, () => { res.statusCode = 404; res.end('{}'); })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await service.dispose(); presentation.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    resetSessionPersistenceForTests(); setSessionStateForTests(null); closeSessionsDb();
    if (prior === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = prior;
    resetMinnowHomeCache(); fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`, calls: { url: string; method: string }[] = [];
  globalThis.fetch = (input, init) => { calls.push({ url: String(input), method: init?.method ?? 'GET' }); return realFetch(new URL(String(input), base), init); };
  setStorageModeForTests('server');
  const advertised = await (await fetch('/api/chats/capabilities')).json();
  assert.equal(advertised.ordinaryExecution.reason, 'released');
  setAgentConversationsCapabilityForTests(advertised);
  await loadSessionsFromStorage({ force: true });
  const value = findChatById('ordinary')!; value.composerDraft = 'Hello server';
  await sendProgrammaticChatText(value, 'Hello server'); await service.idle('ordinary');
  assert.equal(value.chatCommandVersion, 1); assert.equal(value.composerDraft, undefined);
  assert.equal(executions, 1); assert.equal(repository.readTranscript('ordinary')?.messages.at(-1)?.content, 'Hello server');
  const promote = calls.findIndex(call => call.method === 'POST' && call.url.endsWith('/ordinary-routing'));
  assert.ok(promote > 0 && calls.slice(0, promote).some(call => call.method === 'PATCH' || call.method === 'PUT'), 'durable session reconciliation precedes promotion');
  assert.equal(calls.filter(call => call.url.includes('/commands') && call.method === 'POST').length, 1);
  assert.equal(calls.some(call => call.url.includes('/api/generations')), false);
});
