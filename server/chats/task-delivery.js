import { createHash } from 'node:crypto';
import * as diskJournal from '../sub-agents/journal.js';
import { makeEvent } from '../sub-agents/events.js';
import { isTerminal, lastEndedAttempt } from '../sub-agents/derive.js';
import { createChatTaskRepository } from './task-repository.js';
import { createChatOutbox } from './outbox.js';
import { createChatCaller, assertCaller, assertCallerCanTarget } from './caller.js';
import { ChatContractError } from './contracts.js';

const stable = (prefix, value) => prefix + '-' + createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 48);
const ended = new Set(['completed', 'failed', 'stopped', 'recovery_required']);
const pending = new Set(['accepted', 'queued', 'waiting_for_host']);
const fail = (code, message) => { throw new ChatContractError(code, message); };
const completionText = results => {
  const header = '[Sub-agent finished] Use the completed task results below. Open the linked child for any excerpted result.\n\n';
  const budget = Math.floor((115000 - header.length) / Math.max(1, results.length)) - 2;
  return header + results.map(result => {
    const entry = { runId: result.runId, childChatId: result.childChatId, status: result.status,
      summary: result.summary, executionId: result.executionId, link: `#/app/code/chat?chatId=${encodeURIComponent(result.childChatId)}` };
    let line = JSON.stringify(entry);
    while (line.length > budget && entry.summary.length) {
      entry.summary = entry.summary.slice(0, Math.floor(entry.summary.length / 2));
      entry.summaryTruncated = true;
      line = JSON.stringify(entry);
    }
    if (line.length > budget) fail('recovery_required', 'The completion cohort exceeds the supported delivery size');
    return line;
  }).join('\n\n');
};

/** Journal terminal state precedes immutable publication; accepted commands precede delivery acknowledgement. */
export function createChatTaskDelivery({ repository, context, service, journal = diskJournal, taskRepository,
  isRecipientBusy = () => false, isSourceActive = () => false, isReady = () => true, onChange,
  now = Date.now, retryMs = 1000, onError = error => console.error('[agents] task delivery:', error.message) } = {}) {
  if (!repository || !context || !service) throw new TypeError('Task delivery requires its canonical runtime');
  const tasks = taskRepository ?? createChatTaskRepository({ repository, now });
  let engineResolver, disposed = false, recovering = false, draining, requested = false, timer;
  const waiters = new Map();
  function causalOrigin(runId) {
    const command = tasks.commandForRun(runId);
    return { causalRootId: command?.captured?.causalRootId ?? command?.command.provenance.causalRootId ?? command?.command.provenance.sourceTurnId ?? runId,
      causalDepth: command?.captured?.causalDepth ?? 1 };
  }
  const changed = chatId => { try { onChange?.(chatId); } catch {} };
  const report = error => { try { onError(error); } catch {} };
  async function append(owner, event, key) {
    if (!recovering && engineResolver) return (await engineResolver(owner)).append([event], { idempotencyKey: key });
    return journal.appendEvent(owner, event, { idempotencyKey: key });
  }
  function signalResult(runId) { for (const notify of waiters.get(runId) ?? []) notify(); }
  function queueAck(result, disposition, commandId) {
    const outboxId = stable('task-ack', result.runId);
    if (repository.getOutbox(outboxId)) return;
    repository.putOutbox({ outboxId, chatId: result.childChatId, kind: 'agent.result.ack',
      payload: { journalOwnerId: result.journalOwnerId, event: makeEvent('result.delivered', {
        runId: result.runId, parentChatId: result.journalOwnerId, disposition,
        ...(result.completionPolicy.kind === 'wake_delegator' ? { recipientChatId: result.completionPolicy.recipientChatId } : {}),
        ...(commandId ? { commandId } : {}),
      }) } });
  }
  const outbox = createChatOutbox({ repository, handlers: {
    'agent.result.ack': async record => {
      await append(record.payload.journalOwnerId, record.payload.event, record.outboxId);
      const sub = tasks.getSubscription(record.payload.event.runId);
      if (sub?.state === 'accepted' || sub?.state === 'inline_returned') tasks.setSubscription(sub.runId, { state: 'delivered', disposition: record.payload.event.disposition });
    },
  } });
  async function publishRun(owner, runId) {
    const state = await journal.loadState(owner), run = state.runs.get(runId);
    if (!run?.childChatId || !run.commandId || !isTerminal(run)) return null;
    const command = repository.getCommand(run.commandId);
    if (!command) return null;
    const previous = tasks.getResult(runId);
    const last = lastEndedAttempt(run);
    const candidateExecution = last?.executionId ?? run.executionId ?? command.executionId;
    const executionId = candidateExecution && repository.getExecution(candidateExecution)?.runId === runId ? candidateExecution : null;
    const result = previous ?? { version: 1, runId, childChatId: run.childChatId, journalOwnerId: run.journalOwnerId ?? owner,
      ...(executionId ? { executionId } : {}), ...(last?.attemptId ? { attemptId: last.attemptId } : {}),
      ...(last?.resultMessageId ? { resultMessageId: last.resultMessageId } : {}),
      status: run.phase === 'passed' ? 'completed' : run.phase === 'cancelled' ? 'cancelled' : 'failed',
      summary: String(last?.summary || run.abandonedReason || (run.phase === 'cancelled' ? 'Task cancelled.' : 'Task finished.')).slice(0, 120000),
      settledAt: run.endedAt ?? run.requestedAt ?? 0,
      completionPolicy: run.completionPolicy ?? command.captured.completionPolicy ?? { version: 1, kind: 'local_only' } };
    repository.atomic(() => {
      tasks.saveResult(result, { commandId: command.commandId });
      const sub = tasks.ensureSubscription({ runId, policy: result.completionPolicy, inlineWait: command.captured.inlineWait });
      service.settleChildTask({ commandId: command.commandId, runId, result });
      if (sub.state === 'local_only' || sub.state === 'disposed') queueAck(result, sub.state);
    });
    changed(result.childChatId);
    if (result.completionPolicy.kind === 'wake_delegator') changed(result.completionPolicy.recipientChatId);
    signalResult(runId);
    return result;
  }
  function sourceActive(sub) {
    const execution = repository.getExecution(sub.holdExecutionId);
    return execution ? !ended.has(execution.status) : isSourceActive({ chatId: sub.recipientChatId, executionId: sub.holdExecutionId });
  }
  function recipientDisposition(sub) {
    let chat;
    try { chat = repository.getChat(sub.recipientChatId); } catch { return 'missing_chat'; }
    return chat.subAgentAutoResumeBlocked === true || repository.getCancellationEpoch(sub.recipientChatId) !== sub.cancellationEpoch
      ? 'disposed' : null;
  }
  function disposeSubscription(sub, disposition) {
    if (['disposed', 'delivered', 'local_only'].includes(sub.state)) return;
    tasks.setSubscription(sub.runId, { state: 'disposed', disposition });
    const result = tasks.getResult(sub.runId); if (result) queueAck(result, disposition);
    changed(sub.recipientChatId);
  }
  function reconcileHolds() {
    for (const sub of tasks.listSubscriptions({ states: ['inline_hold', 'inline_returned'] })) {
      const invalid = recipientDisposition(sub);
      if (invalid) { disposeSubscription(sub, invalid); continue; }
      const result = tasks.getResult(sub.runId);
      const canonical = result && tasks.canonicalToolResult({ chatId: sub.recipientChatId,
        executionId: sub.holdExecutionId, toolCallId: sub.holdToolCallId, runId: sub.runId });
      if (canonical) {
        repository.atomic(() => {
          tasks.setSubscription(sub.runId, { state: 'inline_returned', disposition: 'inline' });
          queueAck(result, 'inline');
        });
      } else if (!sourceActive(sub)) tasks.setSubscription(sub.runId, { state: 'active', disposition: 'inline_interrupted' });
    }
  }
  async function disposeInvalidSubscriptions() {
    for (const sub of tasks.listSubscriptions({ states: ['active', 'accepted'] })) {
      const invalid = recipientDisposition(sub);
      if (!invalid) continue;
      disposeSubscription(sub, invalid);
      if (sub.cohortId) {
        const cohort = tasks.getCohort(sub.cohortId);
        if (cohort?.state === 'admitted' && cohort.commandId) {
          const command = repository.getCommand(cohort.commandId);
          if (command && pending.has(command.state)) repository.updateCommand(command.commandId, { state: 'cancelled', result: { disposition: 'subscription_disposed' } });
        }
      }
    }
  }
  async function apply() {
    reconcileHolds();
    await disposeInvalidSubscriptions();
    const groups = new Map();
    for (const sub of tasks.listSubscriptions({ states: ['active'] })) {
      if (sub.cohortId || !tasks.getResult(sub.runId)) continue;
      const origin = causalOrigin(sub.runId);
      const key = sub.recipientChatId + ':' + sub.cancellationEpoch + ':' + origin.causalRootId;
      const group = groups.get(key) ?? { recipientChatId: sub.recipientChatId, cancellationEpoch: sub.cancellationEpoch, groupKey: origin.causalRootId, runIds: [] };
      group.runIds.push(sub.runId); groups.set(key, group);
    }
    for (const group of groups.values()) tasks.coalesce(group);
    for (let cohort of tasks.listCohorts()) {
      if (disposed) return;
      const subscriptions = cohort.runIds.map(runId => tasks.getSubscription(runId));
      const invalid = subscriptions.some(sub => !sub || sub.state === 'disposed' || recipientDisposition(sub));
      if (invalid) {
        tasks.settleCohort(cohort.cohortId, { state: 'disposed', disposition: 'disposed' });
        for (const runId of cohort.runIds) { const result = tasks.getResult(runId); if (result) queueAck(result, 'disposed'); }
        continue;
      }
      if (!isReady() || isRecipientBusy(cohort.recipientChatId)) continue;
      cohort = tasks.seal(cohort.cohortId);
      const results = cohort.runIds.map(runId => tasks.getResult(runId));
      if (results.some(result => !result)) fail('recovery_required', 'A sealed completion cohort lost its immutable task result');
      const target = await context.resolveTarget(cohort.recipientChatId);
      const caller = createChatCaller({ actor: 'system', ingress: 'server', chatId: 'task-delivery',
        scope: target.scope, policy: target.policy });
      try {
        const receipt = await service.send(caller, { chatId: cohort.recipientChatId, message: completionText(results),
          mode: 'queue', clientRequestId: cohort.cohortId,
          delivery: { runId: results[0].runId, deliveryId: cohort.cohortId, cancellationEpoch: cohort.cancellationEpoch,
            causalRootId: causalOrigin(results[0].runId).causalRootId,
            causalDepth: Math.max(...results.map(result => causalOrigin(result.runId).causalDepth)) } });
        repository.atomic(() => {
          tasks.settleCohort(cohort.cohortId, { state: 'admitted', commandId: receipt.commandId, disposition: 'accepted' });
          for (const result of results) queueAck(result, 'accepted', receipt.commandId);
        });
      } catch (error) {
        if (error?.code === 'ownership_conflict' && subscriptions.some(sub => recipientDisposition(sub))) { requested = true; continue; }
        throw error;
      }
    }
    await outbox.drain({ limit: 1000 });
  }
  function drain() {
    requested = true;
    if (draining) return draining;
    draining = Promise.resolve().then(async () => {
      do { requested = false; await apply(); } while (requested && !disposed);
    }).finally(() => { draining = undefined; });
    return draining;
  }
  function schedule() {
    if (disposed || timer) return;
    timer = setTimeout(() => { timer = undefined; void drain().catch(report).finally(schedule); }, Math.max(20, retryMs));
    timer.unref?.();
  }
  const delivery = {
    tasks, setEngineResolver: resolver => { engineResolver = resolver; },
    async onSettled(input) {
      const owner = input.run.journalOwnerId ?? input.run.parentChatId;
      if (input.result?.failure?.stopped && !isTerminal(input.run)) {
        await append(owner, makeEvent('run.cancelled', { runId: input.run.runId, reason: 'user' }), stable('stopped-task', input.run.runId));
      }
      await publishRun(owner, input.run.runId); await drain(); schedule();
    },
    async recover() {
      recovering = true;
      try {
        for (const owner of await journal.listEntries()) {
          let state = await journal.loadState(owner);
          for (const run of state.runs.values()) {
            if (!run.childChatId) continue;
            const command = repository.getCommand(run.commandId);
            if (!isTerminal(run) && command && ['removed', 'steered'].includes(command.result?.disposition) &&
                ['cancelled', 'settled'].includes(command.state)) {
              await append(owner, makeEvent('run.cancelled', { runId: run.runId, reason: 'user' }),
                stable('queue-task-cancel', [command.commandId, run.runId]));
              continue;
            }
            for (const attempt of run.attempts.filter(value => !value.ended)) {
              const execution = repository.getExecution(attempt.executionId ?? run.executionId);
              if (!execution || !ended.has(execution.status)) continue;
              const raw = execution.result ?? { outcome: 'crashed', error: 'Execution was interrupted' };
              let outcome = raw.outcome ?? 'crashed', summary = raw.summary ?? raw.error;
              if (outcome === 'no_report') {
                const prose = repository.readExecutionFinalAssistant(execution.executionId);
                if (prose.trim()) { outcome = 'pass'; summary = prose; }
              }
              await append(owner, makeEvent('attempt.ended', { runId: run.runId, attemptId: attempt.attemptId,
                executionId: execution.executionId, outcome, ...(summary ? { summary } : {}),
                evidence: { recovered: true, ...(execution.status === 'recovery_required' ? { recoveryRequired: true } : {}),
                  ...(execution.status === 'stopped' ? { stopped: true } : {}) } }), stable('recovered-attempt', [run.runId, attempt.attemptId]));
            }
          }
          state = await journal.loadState(owner);
          for (const run of state.runs.values()) if (run.childChatId && isTerminal(run)) await publishRun(owner, run.runId);
        }
        reconcileHolds(); await disposeInvalidSubscriptions(); await outbox.drain({ limit: 1000 });
      } finally { recovering = false; }
    },
    async start() {
      schedule();
      if (engineResolver) for (const owner of await journal.listEntries()) await (await engineResolver(owner)).tick();
      return drain();
    },
    drain, reconcileHolds,
    onServiceEvent() { if (!disposed && isReady()) { void drain().catch(report); schedule(); } },
    onHostEvent({ event }) { if (event?.type === 'round_start' || event?.type === 'round_end') delivery.onServiceEvent(); },
    onLegacyReleased() { delivery.onServiceEvent(); },
    async waitForRun({ caller, runId, journalOwnerId, toolCallId, signal, timeoutMs = 120000 } = {}) {
      assertCaller(caller);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 7200000) fail('invalid_request', 'Invalid task wait timeout');
      const state = await journal.loadState(journalOwnerId), run = state.runs.get(runId);
      if (!run?.childChatId) fail('request_not_found', 'Persistent task does not exist');
      const target = await context.resolveTarget(run.childChatId);
      assertCallerCanTarget(caller, target, { operation: 'read', currentPolicy: caller.policy, registry: target.registry });
      if (tasks.descendantChatIds(run.childChatId).includes(caller.chatId)) fail('policy_denied', 'An execution cannot wait on itself or its ancestor');
      const sub = tasks.getSubscription(runId);
      const inline = sub?.holdExecutionId === caller.executionId && sub?.holdToolCallId === toolCallId;
      const deadline = now() + timeoutMs;
      const execution = caller.executionId ? repository.getExecution(caller.executionId) : null;
      const fence = execution ? repository.getLease(caller.chatId) : null;
      if (execution && fence?.executionId === execution.executionId) {
        repository.updateExecution(execution.executionId, { status: 'waiting_for_agents' }, { fence });
        service.notifyExecution?.({ chatId: caller.chatId, executionId: execution.executionId, status: 'waiting_for_agents' });
      }
      return new Promise((resolve, reject) => {
        let poll, done = false;
        const finish = (error, value) => {
          if (done) return; done = true; clearTimeout(poll); signal?.removeEventListener('abort', aborted);
          waiters.get(runId)?.delete(check); if (!waiters.get(runId)?.size) waiters.delete(runId);
          if (error) reject(error); else resolve(value);
        };
        const release = () => { const current = tasks.getSubscription(runId); if (inline && ['inline_hold', 'inline_returned'].includes(current?.state)) tasks.setSubscription(runId, { state: 'active', disposition: 'inline_interrupted' }); };
        const aborted = () => { release(); finish(signal?.reason ?? new DOMException('Stopped', 'AbortError')); };
        const check = () => {
          clearTimeout(poll);
          try {
            if (disposed) return finish(new ChatContractError('capability_unavailable', 'Task wait runtime is closed'));
            const result = tasks.getResult(runId);
            if (result) {
              const current = tasks.getSubscription(runId);
              if (inline && current?.state === 'inline_hold') tasks.setSubscription(runId, { state: 'inline_returned', disposition: 'inline' });
              return finish(null, { runId, childChatId: result.childChatId, status: result.status, summary: result.summary.slice(0, 12000),
                outcome: { kind: result.status, summary: result.summary.slice(0, 12000) } });
            }
            if (now() >= deadline) { release(); return finish(null, { runId, childChatId: run.childChatId, status: 'running', timedOut: true }); }
            poll = setTimeout(check, Math.min(250, Math.max(10, deadline - now())));
          } catch (error) { finish(error); }
        };
        const set = waiters.get(runId) ?? new Set(); set.add(check); waiters.set(runId, set);
        signal?.addEventListener('abort', aborted, { once: true }); if (signal?.aborted) aborted(); else check();
      }).finally(() => {
        if (execution && !signal?.aborted && repository.getExecution(execution.executionId)?.status === 'waiting_for_agents') {
          repository.updateExecution(execution.executionId, { status: 'running' }, { fence });
          service.notifyExecution?.({ chatId: caller.chatId, executionId: execution.executionId, status: 'running' });
        }
      });
    },
    async cancelTree({ chatId, commandId, record: controlRecord, throughPosition = Number.MAX_SAFE_INTEGER } = {}) {
      const planId = stable('cancel-tree', commandId);
      let plan = repository.getOutbox(planId)?.payload;
      if (!plan) repository.atomic(() => {
        const chatIds = tasks.descendantChatIds(chatId), executions = [], runs = [];
        for (const member of chatIds) {
          if (member === chatId && controlRecord?.effectiveCommand?.scope === 'agents') continue;
          if (member !== chatId) repository.advanceCancellationEpoch(member);
          repository.holdQueuedCommands(member, { throughPosition });
          const execution = repository.getLatestExecution(member);
          if (execution && !ended.has(execution.status)) executions.push(execution.executionId);
          for (const row of repository.listCommands({ chatId: member, limit: 1000 })) if (row.runId && row.position <= throughPosition) {
            const relation = repository.getRelation(member);
            if (relation) runs.push({ runId: row.runId, owner: relation.journalOwnerId });
          }
        }
        plan = { chatIds, executions, runs };
        repository.putOutbox({ outboxId: planId, chatId, kind: 'agent.cancel.scope', payload: plan });
      });
      for (const executionId of plan.executions) service.stopExecution(executionId);
      await Promise.all(plan.executions.map(executionId => service.waitExecution(executionId)));
      for (const item of plan.runs) {
        const state = await journal.loadState(item.owner), run = state.runs.get(item.runId);
        if (!run || isTerminal(run)) continue;
        await append(item.owner, makeEvent('run.cancelled', { runId: item.runId, reason: 'user' }), stable('tree-cancel-run', [commandId, item.runId]));
        if (engineResolver) await (await engineResolver(item.owner)).tick();
        const stopped = (await journal.loadState(item.owner)).runs.get(item.runId);
        for (const attempt of stopped?.attempts.filter(value => !value.ended) ?? []) {
          const execution = repository.getExecution(attempt.executionId ?? stopped.executionId);
          if (!execution || !ended.has(execution.status)) continue;
          await append(item.owner, makeEvent('attempt.ended', { runId: item.runId, attemptId: attempt.attemptId,
            executionId: execution.executionId, outcome: 'crashed', summary: 'Task cancelled.',
            evidence: { stopped: true, ...(execution.status === 'recovery_required' ? { recoveryRequired: true } : {}) } }),
          stable('cancelled-attempt', [commandId, attempt.attemptId]));
        }
        await publishRun(item.owner, item.runId);
      }
      await drain();
      const record = repository.getOutbox(planId);
      if (record?.state !== 'applied') {
        const claim = record.state === 'applying' && record.ownerId === 'task-cancel' ? record : repository.claimOutbox(planId, 'task-cancel');
        if (claim) repository.finishOutbox(planId, claim);
      }
    },
    async dispose() {
      disposed = true; clearTimeout(timer); timer = undefined;
      for (const group of waiters.values()) for (const notify of group) notify();
      await draining?.catch(() => {});
    },
  };
  return delivery;
}
