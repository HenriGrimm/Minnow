import { createHash } from 'node:crypto';
import { ChatContractError } from './contracts.js';
import { hashChatPayload } from './repository.js';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const capability = value => typeof value === 'string' && /^tool:[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 48);
const failure = (code, message) => new ChatContractError(code, message);
const RESULT_LIMIT = 2 * 1024 * 1024;
const INPUT_LIMIT = 256 * 1024;
const ACTIVE = new Set(['running', 'waiting_for_host', 'waiting_for_input', 'waiting_for_approval', 'waiting_for_model', 'loading_model', 'waiting_for_agents']);
const notStartedErrors = new WeakSet();
export const isHostToolNotStartedError = error => Boolean(error && typeof error === 'object' && notStartedErrors.has(error));

/**
 * Capabilities belong to a connected host in one server-verified project. An
 * invocation is durably pinned before dispatch; reconnecting another host can
 * never inherit a possibly completed side effect. These outbox records are not
 * drained by the generic outbox dispatcher.
 */
export function createChatHostCapabilities({ repository, resolveProject, beforeDispatch, onChange, now = Date.now,
  maxHosts = 32, maxPending = 128, resultLimit = RESULT_LIMIT, inputLimit = INPUT_LIMIT, retryMs = 3000 } = {}) {
  if (!repository || typeof resolveProject !== 'function') throw new TypeError('Host capabilities require a repository and trusted project resolver');
  const hosts = new Map();
  const pending = new Map();
  let disposed = false;
  const changed = (entry, state) => {
    try { onChange?.({ chatId: entry.input.chatId, executionId: entry.input.executionId, state })?.catch?.(() => {}); } catch {}
  };

  function assertOwner(input) {
    repository.assertFence(input.chatId, input.fence);
    const execution = repository.getExecution(input.executionId);
    if (!execution || execution.chatId !== input.chatId || execution.executionId !== input.fence.executionId || !ACTIVE.has(execution.status)) {
      throw failure('ownership_conflict', 'Host tool execution is no longer active');
    }
  }
  function send(host, envelope) {
    try {
      const result = host.send(envelope);
      result?.catch?.(() => {});
    } catch { /* The same pinned host receives the request on reconnect. */ }
  }
  function finishOutbox(record, error = null) {
    if (record?.state === 'applied') return;
    const claim = record?.state === 'applying' ? record : repository.claimOutbox(record.outboxId, record.payload.hostId, 30_000);
    if (claim) repository.finishOutbox(claim.outboxId, claim, error);
  }
  function complete(entry, error, result) {
    if (entry.finished) return;
    if (error && entry.pinnedHostId) {
      const host = hosts.get(entry.pinnedHostId);
      if (host) send(host, { version: 1, type: 'cancel', invocationId: entry.invocationId });
    }
    entry.finished = true;
    clearTimeout(entry.timer);
    pending.delete(entry.invocationId);
    changed(entry, error ? 'recovery_required' : 'settled');
    entry.input.signal?.removeEventListener('abort', entry.abort);
    if (error) entry.reject(error); else entry.resolve(result);
  }
  async function dispatch(entry) {
    if (entry.finished || entry.dispatching || disposed) return;
    entry.dispatching = true;
    clearTimeout(entry.timer);
    try {
      assertOwner(entry.input);
      await beforeDispatch?.(entry.input);
      // This callback belongs to the execution host, never remote JSON. It
      // performs a new durable Ask if live permission narrowed while waiting.
      await entry.input.revalidate?.();
      if (entry.finished || entry.input.signal?.aborted) return;
      let record = repository.getOutbox(entry.invocationId);
      const pinned = record?.payload?.hostId;
      const host = pinned ? hosts.get(pinned) : [...hosts.values()].find(candidate => candidate.projectId === entry.projectId && candidate.capabilities.has(`tool:${entry.input.name}`));
      if (!host || host.projectId !== entry.projectId || !host.capabilities.has(`tool:${entry.input.name}`)) return;
      if (!record) {
        const context = entry.input.prepared?.toolContext ?? {};
        const envelope = { version: 1, type: 'execute', invocationId: entry.invocationId, hostId: host.hostId,
          projectId: entry.projectId, chatId: entry.input.chatId, executionId: entry.input.executionId,
          toolCallId: entry.input.ctx.toolCallId, name: entry.input.name, args: entry.args,
          context: { modeId: entry.input.prepared?.policy?.modeId ?? context.modeId,
            workspaceRoot: entry.workspaceRoot, runId: context.runId ?? repository.getExecution(entry.input.executionId)?.runId ?? entry.input.executionId,
            agentId: context.agentId ?? entry.input.executionId,
            ...(context.workAgentId ? { workAgentId: context.workAgentId } : {}) } };
        if (!envelope.context.modeId) throw failure('invalid_request', 'Host tools require their captured mode');
        envelope.inputHash = hashChatPayload(envelope);
        record = repository.putOutbox({ outboxId: entry.invocationId, chatId: entry.input.chatId, kind: 'host.tool',
          payload: { hostId: host.hostId, projectId: entry.projectId, fence: entry.input.fence, envelope, createdAt: now() } });
      }
      if (record.kind !== 'host.tool' || record.payload.projectId !== entry.projectId ||
          hashChatPayload(record.payload.fence) !== hashChatPayload(entry.input.fence) ||
          record.payload.envelope.name !== entry.input.name || record.payload.envelope.context.workspaceRoot !== entry.workspaceRoot ||
          hashChatPayload(record.payload.envelope.args) !== hashChatPayload(entry.args)) {
        throw failure('idempotency_conflict', 'Host tool identity was reused with different input');
      }
      entry.pinnedHostId = record.payload.hostId;
      const settled = repository.getOutbox(`result-${entry.invocationId}`);
      if (settled) {
        if (settled.payload.indeterminate) return complete(entry, failure('recovery_required', 'The original host cannot confirm whether this tool effect completed'));
        return complete(entry, null, settled.payload.result);
      }
      if (record.state === 'failed' || record.state === 'applied') throw failure('recovery_required', 'This host invocation needs explicit reconciliation');
      if (record.state !== 'applying') record = repository.claimOutbox(entry.invocationId, host.hostId, 30_000);
      if (!record || record.ownerId !== host.hostId) throw failure('ownership_conflict', 'Host invocation belongs to another owner');
      // Recheck after every asynchronous wait and immediately before sending.
      assertOwner(entry.input);
      if (!entry.finished) { send(host, record.payload.envelope); changed(entry, 'dispatched'); }
    } catch (error) {
      try {
        const record = repository.getOutbox(entry.invocationId);
        if ((!record || (record.state === 'pending' && record.attempts === 0)) && error && typeof error === 'object') {
          notStartedErrors.add(error); error.effectNotStarted = true;
        }
      } catch { /* Unknown durability remains indeterminate. */ }
      complete(entry, error);
    }
    finally {
      entry.dispatching = false;
      if (!entry.finished) {
        try {
          if (repository.getOutbox(entry.invocationId)) {
            entry.timer = setTimeout(() => { void dispatch(entry); }, Math.max(10, retryMs));
            entry.timer.unref?.();
          }
        } catch (error) { complete(entry, error); }
      }
    }
  }

  return {
    register({ hostId, projectId, capabilities, send: deliver } = {}) {
      if (disposed) throw failure('capability_unavailable', 'Host capability broker is closed');
      if (!id(hostId) || !id(projectId) || !Array.isArray(capabilities) || capabilities.length > 256 ||
          capabilities.some(value => !capability(value)) || typeof deliver !== 'function') throw failure('invalid_request', 'Invalid host capability registration');
      if (!hosts.has(hostId) && hosts.size >= maxHosts) throw failure('queue_full', 'Too many execution hosts are connected');
      const host = { hostId, projectId, capabilities: new Set(capabilities), send: deliver };
      hosts.set(hostId, host);
      for (const entry of pending.values()) void dispatch(entry);
      // An invocation without an active process-local waiter is recovery work.
      // Cancel its old callback, rather than replaying it after server restart.
      for (const record of repository.listOutbox({ states: ['pending', 'applying', 'failed'], limit: 1000 })) {
        if (record.kind === 'host.tool' && record.payload.hostId === hostId && record.payload.projectId === projectId && !pending.has(record.outboxId)) {
          send(host, { version: 1, type: 'cancel', invocationId: record.outboxId });
        }
      }
      return () => {
        if (hosts.get(hostId) !== host) return;
        hosts.delete(hostId);
        for (const entry of pending.values()) {
          if (repository.getOutbox(entry.invocationId)?.payload.hostId === hostId) changed(entry, 'waiting_for_host');
        }
      };
    },
    async executeHostTool(input) {
      if (disposed) throw failure('capability_unavailable', 'Host capability broker is closed');
      if (!input || !id(input.chatId) || !id(input.executionId) || typeof input.ctx?.toolCallId !== 'string' ||
          !capability(`tool:${input.name}`) || !input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
        throw failure('invalid_request', 'Invalid host tool invocation');
      }
      assertOwner(input);
      const serialized = JSON.stringify(input.args);
      if (serialized.length > inputLimit) throw failure('invalid_request', 'Host tool input exceeds the transport limit');
      const args = JSON.parse(serialized);
      const scope = await resolveProject(input);
      if (!id(scope?.projectId) || typeof scope.workspaceRoot !== 'string' || !scope.workspaceRoot.trim()) {
        throw failure('workspace_denied', 'Host tool project scope is unavailable');
      }
      const invocationId = `host-${digest([input.executionId, input.ctx.toolCallId])}`;
      if (pending.has(invocationId)) throw failure('ownership_conflict', 'This host tool already has an active waiter');
      if (pending.size >= maxPending) throw failure('queue_full', 'Too many tools are waiting for an execution host');
      return new Promise((resolve, reject) => {
        const entry = { invocationId, input, args, projectId: scope.projectId, workspaceRoot: scope.workspaceRoot,
          resolve, reject, finished: false, dispatching: false, abort: null };
        entry.abort = () => {
          try {
            const record = repository.getOutbox(invocationId);
            if (record?.kind === 'host.tool') {
              const host = hosts.get(record.payload.hostId);
              if (host) send(host, { version: 1, type: 'cancel', invocationId });
              finishOutbox(record, { code: 'recovery_required', message: 'The host call was cancelled after dispatch', retryable: false });
            }
          } catch (error) { return complete(entry, error); }
          complete(entry, input.signal?.reason ?? new DOMException('Stopped', 'AbortError'));
        };
        pending.set(invocationId, entry);
        input.signal?.addEventListener('abort', entry.abort, { once: true });
        if (input.signal?.aborted) entry.abort(); else void dispatch(entry);
      });
    },
    respond({ hostId, invocationId, result, indeterminate } = {}, { projectId } = {}) {
      if (!id(hostId) || !id(invocationId) || (indeterminate !== true && (!result || typeof result.content !== 'string')) ||
          (indeterminate === true && result !== undefined)) throw failure('invalid_request', 'Invalid host tool response');
      const host = hosts.get(hostId), record = repository.getOutbox(invocationId);
      if (!record || record.kind !== 'host.tool') throw failure('request_not_found', 'Host tool invocation does not exist');
      if (!host || record.payload.hostId !== hostId || host.projectId !== record.payload.projectId ||
          (projectId !== undefined && projectId !== record.payload.projectId) || !host.capabilities.has(`tool:${record.payload.envelope.name}`)) {
        throw failure('caller_denied', 'This host does not own the invocation in this project');
      }
      const payload = { hostId, invocationId, inputHash: record.payload.envelope.inputHash,
        ...(indeterminate === true ? { indeterminate: true } : { result: JSON.parse(JSON.stringify(result)) }) };
      if (JSON.stringify(payload).length > resultLimit) throw failure('invalid_request', 'Host tool result exceeds the transport limit');
      const previous = repository.getOutbox(`result-${invocationId}`);
      if (previous) {
        if (hashChatPayload(previous.payload) !== hashChatPayload(payload)) throw failure('idempotency_conflict', 'Host tool result receipt is immutable');
        return { accepted: true, replayed: true };
      }
      // Duplicate receipt reads are safe after settlement; new results need the
      // exact still-live execution fence that licensed the original dispatch.
      assertOwner({ chatId: record.chatId, executionId: record.payload.fence.executionId, fence: record.payload.fence });
      repository.atomic(() => {
        const receipt = repository.putOutbox({ outboxId: `result-${invocationId}`, chatId: record.chatId, kind: 'host.tool.result', payload });
        const claim = repository.claimOutbox(receipt.outboxId, hostId, 30_000);
        if (claim) repository.finishOutbox(claim.outboxId, claim);
        finishOutbox(record, indeterminate === true ? { code: 'recovery_required', message: 'The host cannot confirm completion', retryable: false } : null);
      });
      const entry = pending.get(invocationId);
      if (entry) complete(entry, indeterminate === true ? failure('recovery_required', 'The original host cannot confirm whether this tool effect completed') : null, payload.result);
      return { accepted: true, replayed: false };
    },
    dispose() {
      disposed = true;
      for (const entry of [...pending.values()]) entry.abort();
      hosts.clear();
    },
    get connectedHosts() { return hosts.size; },
    get pendingCount() { return pending.size; },
  };
}
