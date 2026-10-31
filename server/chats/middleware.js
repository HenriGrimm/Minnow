import { createHash, randomUUID } from 'node:crypto';
import { disposeCodexSessions } from '../generations/codex-app-server/lifecycle.js';
import { getRequestWorkspaceRoot } from '../runtime/path-access.js';
import { patchSessionState, useJsonSessionsStore } from '../config/sessions-repo.js';
import { getAgentConversationsFeature } from './feature.js';
import { ChatContractError, CHAT_MIN_CLIENT_VERSION, validateModelSelection } from './contracts.js';
import { hashChatPayload } from './repository.js';
import { assertCallerCanTarget } from './caller.js';
import { createChatPolicy, assertChatPolicyWithinCeiling } from './policy.js';
import { exportChatArchive, importChatArchive } from './archive.js';

const ID = /^[A-Za-z0-9_-]{1,160}$/;
function fail(message) { throw new ChatContractError('invalid_request', message); }
function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) fail('Unsupported conversation input');
}
async function readBody(req, maxBytes = 16 * 1024 * 1024) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) fail('Conversation command is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('Invalid conversation JSON'); }
}
function openEvents(req, res, attach, eventName) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': connected\n\n');
  let cleanup;
  const send = body => {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > 4 * 1024 * 1024) { res.destroy(); return; }
    res.write(`${eventName ? 'event: ' + eventName + '\n' : ''}data: ${JSON.stringify(body)}\n\n`);
  };
  try { cleanup = attach(send); } catch { res.destroy(); return; }
  const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n'); }, 15_000);
  heartbeat.unref?.();
  res.once('close', () => { clearInterval(heartbeat); cleanup?.(); });
}

/** Authenticated transport only. JSON authorship/execution claims are never accepted. */
export function createChatMiddleware({ getRuntime, feature = getAgentConversationsFeature } = {}) {
  if (typeof getRuntime !== 'function') throw new TypeError('A conversation runtime is required');
  return async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/chats/') && !url.pathname.startsWith('/api/chat-commands/')) return next();
    const send = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); };
    try {
      if (req.method === 'GET' && url.pathname === '/api/chats/capabilities') {
        const state = feature();
        const json = useJsonSessionsStore();
        send(200, { ...state, ...(json ? { creationEnabled: false, reason: 'disabled' } : {}), conversationStorage: json ? 'json' : 'sqlite',
          clientProtocol: { version: 1, minReaderVersion: CHAT_MIN_CLIENT_VERSION, minWriterVersion: CHAT_MIN_CLIENT_VERSION } }); return;
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) || url.pathname === '/api/chats/host') {
        const version = req.headers['x-minnow-chat-protocol'] ?? (req.method === 'GET' && url.pathname === '/api/chats/host' ? url.searchParams.get('clientVersion') : null);
        if (version !== String(CHAT_MIN_CLIENT_VERSION)) throw new ChatContractError('unsupported_version', 'Reload Minnow or update its CLI before changing persistent conversations');
      }
      const runtime = await getRuntime();
      const { context, service, repository, presentation } = runtime;
      const ingress = req.minnowAuth?.kind === 'device' ? 'device'
        : ['cli', 'scheduler'].includes(req.headers['x-minnow-chat-client']) ? req.headers['x-minnow-chat-client'] : 'renderer';
      const human = chatId => context.humanCaller(chatId, { workspacePath: getRequestWorkspaceRoot(), ingress });
      if (url.pathname === '/api/chats/archive/export' || url.pathname === '/api/chats/archive/import') {
        if (req.minnowAuth?.kind !== 'host') throw new ChatContractError('caller_denied', 'Only the authenticated local host may transfer a conversation archive');
        if (useJsonSessionsStore()) throw new ChatContractError('capability_unavailable', 'Versioned conversation archives require the SQLite session store');
        if (url.pathname.endsWith('/export') && req.method === 'GET') {
          send(200, { archive: exportChatArchive(repository.getDatabase()) }); return;
        }
        if (url.pathname.endsWith('/import') && req.method === 'POST') {
          const body = await readBody(req, 256 * 1024 * 1024); fields(body, ['archive']);
          const receipt = importChatArchive(repository.getDatabase(), body.archive);
          await runtime.recovery.run({ reason: 'import', chatIds: receipt.chatIds });
          for (const id of receipt.chatIds) presentation.changed(id);
          send(200, { receipt }); return;
        }
        send(405, { error: { code: 'invalid_request', message: 'Method not allowed', retryable: false } }); return;
      }
      if (url.pathname === '/api/chats/host' || url.pathname === '/api/chats/host/results') {
        if (req.minnowAuth?.kind !== 'host') throw new ChatContractError('caller_denied', 'Only the authenticated local host may provide execution capabilities');
        if (!runtime.capabilities) throw new ChatContractError('capability_unavailable', 'Host execution capabilities are unavailable');
        if (url.pathname === '/api/chats/host' && req.method === 'GET') {
          if ([...url.searchParams.keys()].some(key => !['hostId', 'capabilities', 'clientVersion'].includes(key))) fail('Unsupported host registration input');
          const hostId = url.searchParams.get('hostId'), encoded = url.searchParams.get('capabilities') ?? '[]';
          let capabilities;
          try { if (encoded.length > 70_000) fail('Host capability registration is too large'); capabilities = JSON.parse(encoded); }
          catch { fail('Invalid host capability registration'); }
          if (!ID.test(hostId ?? '') || !Array.isArray(capabilities) || capabilities.length > 256 ||
            capabilities.some(value => typeof value !== 'string' || !/^tool:[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/.test(value))) fail('Invalid host capability registration');
          const project = await context.project();
          openEvents(req, res, write => runtime.capabilities.register({ hostId, projectId: project.projectId, capabilities, send: write }), 'host-tool');
          return;
        }
        if (url.pathname === '/api/chats/host/results' && req.method === 'POST') {
          const body = await readBody(req); fields(body, ['hostId', 'invocationId', 'result', 'indeterminate']);
          const project = await context.project();
          send(200, await runtime.capabilities.respond(body, { projectId: project.projectId })); return;
        }
        send(405, { error: { code: 'invalid_request', message: 'Method not allowed', retryable: false } }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/chats/events') {
        const project = await context.project();
        const chatId = url.searchParams.get('chatId') || undefined;
        if (chatId) {
          const { caller, target } = await human(chatId);
          assertCallerCanTarget(caller, target, { operation: 'read', currentPolicy: target.currentPolicy, registry: target.registry });
        }
        openEvents(req, res, write => presentation.subscribe({ projectId: project.projectId, chatId, send: write })); return;
      }
      const commandMatch = /^\/api\/chat-commands\/([A-Za-z0-9_-]{1,160})$/.exec(url.pathname);
      if (commandMatch && req.method === 'GET') {
        const record = repository.getCommand(commandMatch[1]);
        if (!record) throw new ChatContractError('command_not_found', 'Conversation command does not exist');
        const { caller } = await human(record.chatId);
        send(200, { receipt: await service.readCommand(caller, record.commandId) }); return;
      }
      const legacy = /^\/api\/chats\/([A-Za-z0-9_-]{1,160})\/legacy\/([A-Za-z0-9_-]{1,160})\/continue$/.exec(url.pathname);
      const match = legacy ? [legacy[0], legacy[1], 'legacy-continue', legacy[2]] : /^\/api\/chats\/([A-Za-z0-9_-]{1,160})(?:\/(commands|configuration|requests|ack)(?:\/([A-Za-z0-9_-]{1,160})\/respond)?)?$/.exec(url.pathname);
      if (!match) { send(404, { error: { code: 'chat_not_found', message: 'Conversation operation does not exist', retryable: false } }); return; }
      const [, chatId, operation, requestId] = match;
      if (!operation && req.method === 'DELETE') {
        if (!['host', 'device'].includes(req.minnowAuth?.kind)) throw new ChatContractError('caller_denied', 'Only an authenticated human may delete a conversation');
        const body = await readBody(req); fields(body, ['clientRequestId']);
        if (!ID.test(body.clientRequestId ?? '')) fail('A deletion receipt identity is required');
        const project = await context.project(getRequestWorkspaceRoot());
        const receiptId = `delete-${createHash('sha256').update([project.projectId, chatId, ingress, body.clientRequestId].join(':')).digest('hex').slice(0, 40)}`;
        const replay = () => {
          const prior = repository.getOutbox(receiptId);
          if (!prior) return null;
          if (prior.kind !== 'conversation.deleted' || prior.payload.projectId !== project.projectId || prior.payload.chatId !== chatId ||
            prior.payload.ingress !== ingress || prior.payload.clientRequestId !== body.clientRequestId) throw new ChatContractError('caller_denied', 'The deletion receipt belongs to another conversation scope');
          return { ...prior.payload.receipt, replayed: true };
        };
        const finish = async receipt => {
          // The durable receipt commits before native checkpoint cleanup. A
          // rollback must never forget state for a conversation still on disk.
          await disposeCodexSessions(session => session.chatId === chatId, { forget: true }).catch(() => {});
          send(200, { receipt });
        };
        const prior = replay();
        if (prior) { await finish(prior); return; }
        const { caller, target } = await human(chatId);
        assertCallerCanTarget(caller, target, { operation: 'read', currentPolicy: target.currentPolicy, registry: target.registry });
        if (target.scope.projectId !== project.projectId) throw new ChatContractError('caller_denied', 'The conversation scope changed before deletion');
        const receipt = repository.atomic(() => {
          const prior = replay(); if (prior) return prior;
          const db = repository.getDatabase();
          const family = db.prepare('WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT r.chat_id FROM chat_relations r JOIN family f ON r.parent_chat_id=f.id) SELECT id FROM family').all(chatId);
          if (family.some(row => runtime.hasExternalExecution?.(row.id))) throw new ChatContractError('ownership_conflict', 'Stop this conversation and its active agents before deleting it');
          const replacementChat = db.prepare('SELECT COUNT(*) AS n FROM chats').get().n === 1 ? {
            id: randomUUID(), name: 'New chat', workspacePath: target.chat.workspacePath ?? target.scope.canonicalKey,
            providerId: '', modelId: '', modeId: 'general', workAgentAuto: true,
            history: [], lastStats: null, modelInfo: {}, updatedAt: Date.now(), lastMessageAt: Date.now(),
          } : undefined;
          db.prepare('INSERT OR IGNORE INTO chat_conversation_tombstones (chat_id,deleted_at) VALUES (?,?)').run(chatId, Date.now());
          const result = patchSessionState({ deleteChatIds: [chatId], ...(replacementChat ? { chats: [replacementChat] } : {}) }, { db, deferDeleteCleanup: true });
          const receipt = { chatId, clientRequestId: body.clientRequestId, disposition: 'deleted', revision: result.revision,
            retainedWorktree: Boolean(target.chat.agentConversation) || family.length > 1 || target.chat.chatCommandVersion === 1,
            ...(replacementChat ? { replacementChat } : {}) };
          repository.putOutbox({ outboxId: receiptId, chatId, kind: 'conversation.deleted', payload: { projectId: project.projectId, chatId, ingress,
            clientRequestId: body.clientRequestId, receipt } });
          const claim = repository.claimOutbox(receiptId, 'conversation-delete'); repository.finishOutbox(receiptId, claim);
          return receipt;
        });
        await finish(receipt); return;
      }
      const { caller, target } = await human(chatId);
      assertCallerCanTarget(caller, target, { operation: 'read', currentPolicy: target.currentPolicy, registry: target.registry });
      if (operation === 'legacy-continue' && req.method === 'POST') {
        if (!['host', 'device'].includes(req.minnowAuth?.kind) || caller.actor !== 'human') throw new ChatContractError('caller_denied', 'Only an authenticated human may continue a historical task');
        const body = await readBody(req); fields(body, ['clientRequestId', 'title']);
        if (!runtime.legacyImports) throw new ChatContractError('capability_unavailable', 'Legacy continuation is unavailable on this host');
        const receipt = await runtime.legacyImports.continue(caller, { parentChatId: chatId, runId: requestId, ...body });
        send(200, { receipt }); return;
      }
      if (!operation && req.method === 'GET' && url.searchParams.get('view') === 'navigation') {
        send(200, { chatId, available: true }); return;
      }
      const snapshot = receipt => ({ ...(receipt ? { receipt } : {}), frame: presentation.frame(chatId) });
      if (operation === 'ack' && req.method === 'POST' && !requestId) {
        const body = await readBody(req); fields(body, ['messageSeq', 'executionId']);
        const activity = repository.acknowledgeActivity(chatId, body);
        presentation.changed(chatId); send(200, { chatId, activity }); return;
      }
      if (!operation && req.method === 'GET') { send(200, { ...await service.status(caller, chatId), ...snapshot() }); return; }
      if (operation === 'requests' && req.method === 'GET' && !requestId) {
        if ([...url.searchParams.keys()].some(key => !['pending_cursor', 'limit'].includes(key))) fail('Unsupported request page input');
        if (url.searchParams.getAll('pending_cursor').length > 1 || url.searchParams.getAll('limit').length > 1) fail('Duplicate request page input');
        const afterRequestId = url.searchParams.get('pending_cursor') ?? undefined;
        const rawLimit = url.searchParams.get('limit');
        if (afterRequestId !== undefined && !ID.test(afterRequestId)) fail('Invalid request page cursor');
        if (rawLimit !== null && !/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(rawLimit)) fail('Invalid request page limit');
        send(200, repository.listRequestPresentation(chatId, { afterRequestId, limit: rawLimit === null ? 32 : Number(rawLimit), recentLimit: afterRequestId ? 0 : 8 })); return;
      }
      if (operation === 'requests' && req.method === 'POST' && requestId) {
        const body = await readBody(req); fields(body, ['answer', 'clientRequestId']);
        if (!ID.test(body.clientRequestId ?? '')) fail('An answer receipt identity is required');
        const request = repository.getRequest(requestId);
        if (!request || request.chatId !== chatId) throw new ChatContractError('request_not_found', 'This question does not belong to the conversation');
        assertCallerCanTarget(caller, target, { operation: 'respond', currentPolicy: target.currentPolicy, registry: target.registry });
        const result = await runtime.requests.respond(requestId, { answerCommandId: body.clientRequestId, answer: body.answer, context: { caller, target } });
        presentation.changed(chatId); send(200, { request: result.request, ...snapshot() }); return;
      }
      if (operation === 'configuration' && req.method === 'PATCH') {
        const body = await readBody(req); fields(body, ['action', 'selection', 'modeId', 'name', 'pinned', 'expectedProfileVersion', 'clientRequestId']);
        if (body.action !== undefined && body.action !== 'configure') fail('Unsupported configuration action');
        if (body.expectedProfileVersion !== undefined && (!Number.isSafeInteger(body.expectedProfileVersion) || body.expectedProfileVersion < 0)) fail('Invalid profile revision');
        if (!ID.test(body.clientRequestId ?? '')) fail('A configuration receipt identity is required');
        if (target.chat.chatCommandVersion !== 1) throw new ChatContractError('capability_unavailable', 'This conversation uses the existing settings controls');
        if (target.chat.agentConversation?.capabilities?.canChooseModel === false && body.selection) throw new ChatContractError('policy_denied', 'This conversation does not permit model changes');
        const receiptId = `config-${createHash('sha256').update([caller.scope.projectId, chatId, caller.ingress, body.clientRequestId].join(':')).digest('hex').slice(0, 40)}`;
        const intentHash = hashChatPayload(body);
        const previous = repository.getOutbox(receiptId);
        if (previous) {
          if (previous.payload.intentHash !== intentHash) throw new ChatContractError('idempotency_conflict', 'Configuration receipt was reused');
          send(200, snapshot({ ...previous.payload.result, replayed: true })); return;
        }
        assertCallerCanTarget(caller, target, { operation: 'send', currentPolicy: target.currentPolicy, registry: target.registry });
        const patch = {};
        let selection;
        if (Object.hasOwn(body, 'selection')) {
          const parsed = validateModelSelection(body.selection);
          if (!parsed.ok) throw new ChatContractError(parsed.error.code, parsed.error.message);
          const resolved = await runtime.resolveModelSelection({ target: { ...parsed.value, options: parsed.value.options ?? {} } });
          selection = resolved.selection;
          Object.assign(patch, { providerId: selection.providerId, modelId: selection.modelId });
        }
        if (body.modeId !== undefined) {
          if (!['general', 'build', 'plan', 'debug'].includes(body.modeId)) fail('Invalid conversation mode');
          patch.modeId = body.modeId;
        }
        if (body.name !== undefined) {
          if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 256) fail('Invalid conversation name');
          patch.name = body.name.trim();
        }
        if (body.pinned !== undefined) { if (typeof body.pinned !== 'boolean') fail('Invalid pin setting'); patch.pinned = body.pinned; }
        const nextPolicy = patch.modeId ? createChatPolicy(await runtime.resolvePolicyInput({ ...target.chat, modeId: patch.modeId }, target.scope, target.registry)) : target.policy;
        assertChatPolicyWithinCeiling(nextPolicy, target.policy);
        const next = body.selection || patch.modeId ? {
          profileId: target.profile?.profileId ?? `profile-${chatId}`,
          profileVersion: (target.profile?.profileVersion ?? 0) + 1,
          snapshot: { ...(target.profile?.snapshot ?? {}), policy: nextPolicy, ...(selection ? { modelSelection: selection, exactModel: selection.providerId !== 'minnow-router' } : {}) },
        } : undefined;
        const result = repository.atomic(() => {
          const accepted = repository.getOutbox(receiptId);
          if (accepted) {
            if (accepted.payload.intentHash !== intentHash) throw new ChatContractError('idempotency_conflict', 'Configuration receipt was reused');
            return { ...accepted.payload.result, replayed: true };
          }
          const chat = repository.configureChat(chatId, patch, { expectedProfileVersion: body.expectedProfileVersion, ...(next ? { profile: next } : {}) });
          const result = { chatId, profileReference: chat.profileReference, disposition: 'settled' };
          repository.putOutbox({ outboxId: receiptId, chatId, kind: 'configuration.receipt', payload: { intentHash, result } });
          const claim = repository.claimOutbox(receiptId, 'configuration-receipt');
          repository.finishOutbox(receiptId, claim);
          return result;
        });
        presentation.changed(chatId); send(200, snapshot(result)); return;
      }
      if (operation === 'commands' && req.method === 'POST') {
        const body = await readBody(req);
        const inputFields = {
          send: ['action', 'text', 'images', 'mode', 'clientRequestId'],
          steer: ['action', 'text', 'clientRequestId'],
          stop: ['action', 'scope', 'executionId', 'runId', 'clientRequestId', 'expectedLegacyOwnerId'],
          edit: ['action', 'text', 'itemId', 'expectedRevision', 'clientRequestId'],
          remove: ['action', 'itemId', 'expectedRevision', 'clientRequestId'],
          push: ['action', 'itemId', 'expectedRevision', 'clientRequestId'],
        };
        if (!body || !Object.hasOwn(inputFields, body.action)) fail('Unsupported conversation command');
        fields(body, inputFields[body.action]);
        const base = { chatId, clientRequestId: body.clientRequestId };
        let receipt;
        if (body.action === 'send' || body.action === 'steer') {
          if (target.chat.agentConversation?.capabilities?.canSend === false) throw new ChatContractError('policy_denied', 'This conversation is inspect-only');
          receipt = await service.send(caller, { ...base, message: body.text, mode: body.action === 'steer' ? 'steer' : body.mode ?? 'auto', ...(body.images ? { images: body.images } : {}) });
        } else if (body.action === 'stop') receipt = await service.stop(caller, { ...base, scope: body.scope ?? 'turn', ...(body.executionId ? { executionId: body.executionId } : {}), ...(body.runId ? { runId: body.runId } : {}),
          ...(body.expectedLegacyOwnerId !== undefined ? { expectedLegacyOwnerId: body.expectedLegacyOwnerId } : {}) });
        else {
          const control = { ...base, targetCommandId: body.itemId, expectedRevision: body.expectedRevision };
          if (body.action === 'edit') receipt = await service.editQueued(caller, { ...control, message: body.text });
          else if (body.action === 'remove') receipt = await service.removeQueued(caller, control);
          else if (body.action === 'push') receipt = await service.pushQueued(caller, control);
          else fail('Unsupported conversation command');
        }
        send(202, snapshot(receipt)); return;
      }
      send(405, { error: { code: 'invalid_request', message: 'Method not allowed', retryable: false } });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const known = error instanceof ChatContractError;
      send(known ? error.statusCode : 500, { error: known ? error.toJSON() : { code: 'internal_error', message: 'Conversation operation failed', retryable: false } });
    }
  };
}
