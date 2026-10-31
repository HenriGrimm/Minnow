import { createHash } from 'node:crypto';
import { ChatContractError } from './contracts.js';
import { degradeNoReportIfProse } from '../sub-agents/effector-runner.js';
import { agentsDir } from '../sub-agents/journal.js';
import { recordTranscriptEvent, recordTranscriptEnd, flushTranscripts } from '../orchestrator/transcripts.js';
import { emitLive } from '../orchestrator/live-events.js';
import { shouldEmitSubAgentLiveTurnEvent } from '../runner/turn-event.js';

const attemptIdentity = (run, ordinal) => 'sa-' + createHash('sha256').update(JSON.stringify([run.runId, ordinal])).digest('hex').slice(0, 48);
const liveExecutions = new Map();

/** Family engines may be cached before the production chat runtime boots. */
export function createLazyPersistentSubAgentEffector({ getRuntime, ...options }) {
  let runtime;
  return createPersistentSubAgentEffector({ ...options,
    service: { async startAdmittedChildTask(input) {
      runtime = await getRuntime();
      return runtime.service.startAdmittedChildTask(input);
    }, async canResumeQuestionExecution(executionId) {
      runtime = await getRuntime();
      return runtime.service.canResumeQuestionExecution?.(executionId) === true;
    } },
    repository: { readExecutionFinalAssistant(executionId) {
      if (!runtime) throw new ChatContractError('capability_unavailable', 'The chat runtime has not admitted this execution');
      return runtime.repository.readExecutionFinalAssistant(executionId);
    } },
    onSettled: async input => {
      const current = runtime ?? await getRuntime();
      await current.taskDelivery?.onSettled(input);
    },
  });
}
function emitObserved(entry, event) {
  const journalOwnerId = entry.run.journalOwnerId;
  try {
    recordTranscriptEvent({ entryDir: agentsDir(journalOwnerId), attemptId: entry.attemptId, taskId: entry.run.runId, role: 'sub-agent', event });
    if (event.type === 'delta' || event.type === 'thinking' || shouldEmitSubAgentLiveTurnEvent(event.type)) {
      emitLive({ key: journalOwnerId, boardId: journalOwnerId, taskId: entry.run.runId, role: 'sub-agent', attemptId: entry.attemptId, event });
    }
  } catch (error) { entry.onError(error); }
}
function flushObserved(entry) {
  clearTimeout(entry.liveTimer); entry.liveTimer = undefined;
  for (const event of entry.livePending.values()) emitObserved(entry, event);
  entry.livePending.clear();
}
function forgetObserved(entry) {
  flushObserved(entry);
  liveExecutions.delete(entry.reservation.executionId);
}

/** Passive family-channel projection; canonical child storage always wins. */
export function observePersistentAgentTurn({ chatId, executionId, event } = {}) {
  const entry = liveExecutions.get(executionId);
  if (!entry || !entry.activated || entry.run.childChatId !== chatId || !event || typeof event.type !== 'string') return;
  if (event.type === 'delta' || event.type === 'thinking') {
    entry.livePending.set(event.type, event);
    if (!entry.liveTimer) {
      entry.liveTimer = setTimeout(() => flushObserved(entry), 80);
      entry.liveTimer.unref?.();
    }
    return;
  }
  flushObserved(entry);
  emitObserved(entry, event);
}

async function finishAudit(entry, result) {
  if (entry.auditEnded) return;
  entry.auditEnded = true; forgetObserved(entry);
  try {
    const entryDir = agentsDir(entry.run.journalOwnerId);
    recordTranscriptEnd({ entryDir, attemptId: entry.attemptId, outcome: result.outcome,
      ...(typeof result.summary === 'string' ? { summary: result.summary } : {}) });
    await flushTranscripts(entry.run.journalOwnerId, entry.attemptId, { entryDir });
  } catch (error) { entry.onError(error); }
}

/**
 * One composite effector lets the existing graph schedule both legacy attempts
 * and durable conversations. It reserves through the command service and never
 * constructs a provider or tool loop itself.
 */
export function createPersistentSubAgentEffector({ legacyEffector, service, repository, getState, onSettled,
  onError = error => console.error('[agents] durable task settlement failed:', error instanceof Error ? error.message : String(error)) } = {}) {
  if (!legacyEffector || !service || !repository || typeof getState !== 'function') throw new TypeError('A persistent task bridge requires its legacy effector, service and graph state');
  const running = new Map();
  const reportError = error => { try { onError(error); } catch {} };
  const listeners = [];
  const started = [];
  legacyEffector.onEnd?.(async end => { for (const listener of listeners) await listener(end); });

  async function settle(entry, rawResult) {
    if (entry.stopped || entry.vanished) return;
    let result = rawResult;
    const final = repository.readExecutionFinalAssistant?.(entry.reservation.executionId) ?? '';
    if (result.outcome === 'no_report') result = degradeNoReportIfProse(result, final ? [{ role: 'assistant', content: final }] : [], entry.run.summarySchema ?? 'minnow.sub-agent.v1');
    const evidence = { childChatId: entry.run.childChatId, commandId: entry.run.commandId,
      ...(result.outcome === 'crashed' ? { error: result.error, ...(result.failure ? { failure: result.failure } : {}) } : {}),
      ...(result.outcome === 'pass' && result.evidence ? { evidence: result.evidence } : {}),
      ...(result.outcome === 'fail' ? { blockers: result.blockers } : {}),
      ...(result.outcome === 'blocked' ? { needs: result.needs } : {}),
      ...(result.failure?.recoveryRequired === true ? { recoveryRequired: true } : {}),
      ...(result.failure?.stopped === true ? { stopped: true } : {}),
    };
    const end = { attemptId: entry.attemptId, taskId: entry.run.runId, role: 'sub-agent', outcome: result.outcome,
      executionId: entry.reservation.executionId, evidence,
      ...(typeof result.summary === 'string' ? { summary: result.summary } : typeof result.error === 'string' ? { summary: result.error } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
    };
    try {
      await finishAudit(entry, result);
      // The entry stays inspectable until attempt.ended and any implied
      // terminal event have committed, including the existing buffered-end path.
      for (const listener of listeners) await listener(end);
      const state = await getState();
      await onSettled?.({ run: state.runs.get(entry.run.runId) ?? entry.run,
        executionId: entry.reservation.executionId, attemptId: entry.attemptId, result, end });
    } finally { forgetObserved(entry); running.delete(entry.attemptId); }
  }

  function attach(run, attemptId, reservation, seedKind) {
    const entry = { run, attemptId, reservation, stopped: false, vanished: false, activated: false,
      livePending: new Map(), onError: reportError };
    running.set(attemptId, entry); liveExecutions.set(reservation.executionId, entry);
    started.push({ taskId: run.runId, role: 'sub-agent', attemptId, cwd: run.cwd, seedKind });
    reservation.finished.then(result => settle(entry, result), error => settle(entry, {
      outcome: 'crashed', error: error instanceof Error ? error.message : String(error),
      failure: { code: 'recovery_required', recoveryRequired: true },
    })).catch(reportError).finally(() => { forgetObserved(entry); running.delete(attemptId); });
    return { attemptId, executionId: reservation.executionId, commandId: run.commandId,
      ...(run.model ? { model: run.model } : {}) };
  }

  return {
    inspect() { return [...legacyEffector.inspect(), ...[...running.values()].map(entry => ({ taskId: entry.run.runId,
      role: 'sub-agent', attemptId: entry.attemptId, executionId: entry.reservation.executionId, cwd: entry.run.cwd }))]; },
    async reattach(state) {
      const attached = [];
      if (typeof service.canResumeQuestionExecution !== 'function') return attached;
      for (const run of state.runs?.values() ?? []) {
        if (!run.childChatId || ['passed', 'abandoned', 'cancelled'].includes(run.phase)) continue;
        const attempt = run.attempts.find(row => !row.ended);
        const executionId = attempt?.executionId ?? run.executionId;
        if (!attempt || !executionId || running.has(attempt.attemptId) || !await service.canResumeQuestionExecution(executionId)) continue;
        const reservation = await service.startAdmittedChildTask({ commandId: run.commandId, runId: run.runId, attemptId: attempt.attemptId });
        if (reservation.deferred === true) continue;
        attached.push({ handle: attach(run, attempt.attemptId, reservation, attempt.seedKind),
          desired: { taskId: run.runId, role: 'sub-agent', seedKind: attempt.seedKind ?? 'initial' } });
      }
      return attached;
    },
    async start(desired, options = {}) {
      const state = await getState();
      const run = state.runs.get(desired.taskId);
      if (!run?.childChatId) return legacyEffector.start(desired, options);
      if (!run.commandId || run.executionKind !== 'chat') throw new ChatContractError('invalid_request', 'The durable assignment is missing its command binding');
      const attemptId = attemptIdentity(run, run.attempts.length + 1);
      const reservation = await service.startAdmittedChildTask({ commandId: run.commandId, runId: run.runId, attemptId, signal: options.signal });
      if (reservation.deferred === true) return reservation;
      return attach(run, attemptId, reservation, desired.seedKind);
    },
    async onStarted(handle, desired) {
      const entry = running.get(handle.attemptId);
      if (!entry) return legacyEffector.onStarted?.(handle, desired);
      // Do not await the whole attempt: the graph must remain responsive to
      // cancellation and other family work while this shared runner executes.
      entry.activated = true;
      void entry.reservation.activate().catch(reportError);
    },
    async stop(attemptId) {
      const entry = running.get(attemptId);
      if (!entry) return legacyEffector.stop(attemptId);
      entry.stopped = true;
      entry.reservation.stop();
      try {
        const result = await entry.reservation.finished;
        await finishAudit(entry, result);
      } finally { forgetObserved(entry); running.delete(attemptId); }
    },
    onEnd(listener) { listeners.push(listener); },
    preflight: (...args) => legacyEffector.preflight?.(...args),
    get started() { return [...(legacyEffector.started ?? []), ...started]; },
    vanishAll() { legacyEffector.vanishAll?.(); for (const entry of running.values()) { entry.vanished = true; forgetObserved(entry); } running.clear(); },
    seedTranscript: (...args) => legacyEffector.seedTranscript?.(...args),
  };
}
