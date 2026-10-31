import { createHash } from 'node:crypto';
import { ChatContractError } from './contracts.js';
import { assertExecutionCaller } from './caller.js';

const requestIdentity = (executionId, toolCallId, kind) =>
  `rq-${createHash('sha256').update(JSON.stringify([executionId, toolCallId, kind])).digest('hex').slice(0, 48)}`;

/** Durable requests with disposable process-local waiters. No provider callbacks are serialized. */
export function createChatRequestService({ repository, authorizeResponse, assertLegacyOwner, now = Date.now, pollMs = 250, onChange } = {}) {
  if (!repository) throw new Error('A request service requires its conversation repository');
  const listeners = new Map();
  const legacyOwners = new Map();
  const validLegacy = caller => {
    assertExecutionCaller(caller);
    return typeof assertLegacyOwner === 'function' && assertLegacyOwner(caller) === true;
  };
  const notify = request => {
    for (const listener of listeners.get(request.requestId) ?? []) listener();
    try { onChange?.(request)?.catch?.(() => {}); } catch { /* A disconnected viewer cannot undo a durable request. */ }
  };
  function expire(request, state = 'expired') {
    if (request.state !== 'pending') return request;
    const result = repository.settleRequest(request.requestId, { state, settledAt: now() });
    legacyOwners.delete(request.requestId);
    notify(result);
    return result;
  }
  return {
    openLegacy({ caller, toolCallId, kind = 'approval', title, presentation, expiresAt } = {}) {
      if (!validLegacy(caller)) throw new ChatContractError('caller_not_active', 'The original renderer no longer owns this request');
      if (kind !== 'approval') throw new ChatContractError('invalid_request', 'Legacy execution supports durable approvals only');
      const requestId = requestIdentity(caller.executionId, toolCallId, kind);
      const existing = repository.getRequest(requestId);
      if (!legacyOwners.has(requestId) && legacyOwners.size >= 128) throw new ChatContractError('queue_full', 'Too many legacy approvals are pending');
      const request = repository.saveLegacyRequest({ version: 1, requestId, chatId: caller.chatId, executionId: caller.executionId,
        toolCallId, kind, state: 'pending', createdAt: existing?.createdAt ?? now(), title, presentation,
        expiresAt: expiresAt ?? existing?.expiresAt ?? now() + 10 * 60 * 1000,
      }, { assertOwner: () => validLegacy(caller) });
      legacyOwners.set(requestId, caller);
      notify(request); return request;
    },
    open({ chatId, executionId, toolCallId, kind, title, presentation, expiresAt, fence }) {
      const requestId = requestIdentity(executionId, toolCallId, kind);
      const existing = repository.getRequest(requestId);
      if (existing) {
        if (existing.chatId !== chatId || existing.executionId !== executionId || existing.toolCallId !== toolCallId || existing.kind !== kind ||
            existing.title !== title || JSON.stringify(existing.presentation) !== JSON.stringify(presentation) || existing.expiresAt !== expiresAt) {
          throw new ChatContractError('idempotency_conflict', 'Human request identity was reused');
        }
        return existing;
      }
      const request = repository.saveRequest({ version: 1, requestId, chatId, executionId, toolCallId,
        kind, state: 'pending', createdAt: now(), title, presentation,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      }, { fence });
      notify(request);
      return request;
    },
    wait(requestId, { signal } = {}) {
      return new Promise((resolve, reject) => {
        let timer;
        let finished = false;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          listeners.get(requestId)?.delete(check);
          if (!listeners.get(requestId)?.size) listeners.delete(requestId);
          signal?.removeEventListener('abort', abort);
        };
        const finish = (error, answer) => {
          if (finished) return;
          finished = true; cleanup();
          legacyOwners.delete(requestId);
          if (error) reject(error); else resolve(answer);
        };
        const abort = () => {
          // Remove this waiter before notification so cancellation retains the
          // original AbortError, rather than racing its own terminal check.
          const reason = signal?.reason ?? new DOMException('Request cancelled', 'AbortError');
          finish(reason);
          try {
            const request = repository.getRequest(requestId);
            if (request?.state === 'pending') expire(request, 'cancelled');
          } catch { /* The original cancellation still ends the disposed waiter. */ }
        };
        const check = () => {
          if (finished) return;
          if (timer) clearTimeout(timer);
          try {
            const request = repository.getRequest(requestId);
            if (!request) return finish(new ChatContractError('request_not_found', 'Human request does not exist'));
            if (request.state === 'answered') { legacyOwners.delete(requestId); return finish(null, repository.readRequestAnswer(requestId)); }
            if (request.state !== 'pending') return finish(new ChatContractError('request_expired', 'Human request is no longer pending'));
            const legacy = legacyOwners.get(requestId);
            if (legacy && !validLegacy(legacy)) {
              expire(request);
              return finish(new ChatContractError('request_expired', 'The original renderer no longer owns this approval'));
            }
            if (request.expiresAt !== undefined && request.expiresAt <= now()) {
              expire(request);
              return finish(new ChatContractError('request_expired', 'Human request expired'));
            }
            timer = setTimeout(check, Math.max(10, pollMs));
          } catch (error) { finish(error); }
        };
        let group = listeners.get(requestId);
        if (!group) { group = new Set(); listeners.set(requestId, group); }
        group.add(check);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort(); else check();
      });
    },
    async respond(requestId, { answerCommandId, answer, context } = {}) {
      const request = repository.getRequest(requestId);
      if (!request) throw new ChatContractError('request_not_found', 'Human request does not exist');
      if (typeof authorizeResponse !== 'function' || !await authorizeResponse(request, context)) {
        throw new ChatContractError('caller_denied', 'This caller cannot answer the human request');
      }
      const legacy = legacyOwners.get(requestId);
      if (request.state === 'pending' && legacy && !validLegacy(legacy)) {
        expire(request);
        throw new ChatContractError('request_expired', 'The original renderer no longer owns this approval');
      }
      if (request.state === 'pending' && request.kind === 'approval' && !listeners.get(requestId)?.size) {
        expire(request);
        throw new ChatContractError('request_expired', 'The original approval callback is no longer live');
      }
      const result = repository.respondToRequest(requestId, { answerCommandId, answer, settledAt: now() });
      notify(result.request);
      return result;
    },
    expireExecution(executionId, chatId, state = 'expired') {
      const records = repository.listRequests(chatId).filter(request => request.executionId === executionId);
      return records.map(request => expire(request, state));
    },
    expireUnownedLegacyApprovals() {
      const rows = repository.getDatabase().prepare("SELECT q.payload_json FROM chat_requests q LEFT JOIN chat_executions e ON e.execution_id=q.execution_id WHERE q.state='pending' AND e.execution_id IS NULL AND json_extract(q.payload_json,'$.kind')='approval'").all();
      return rows.map(row => JSON.parse(row.payload_json)).filter(request => !legacyOwners.has(request.requestId)).map(request => expire(request));
    },
    hasLiveWaiter: requestId => Boolean(listeners.get(requestId)?.size),
  };
}
