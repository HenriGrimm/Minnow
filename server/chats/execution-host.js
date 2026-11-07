import { createHash } from 'node:crypto';
import { runTurn } from '../runner/run-turn.js';
import { createInProcessToolDispatch } from '../runner/tool-dispatch.js';
import { ChatContractError, validateChatCommand } from './contracts.js';
import { assertChatPolicy, assertChatToolAllowed } from './policy.js';
import { createChatTranscriptStore } from './transcript-store.js';
import { createChatRequestService } from './requests.js';
import { isHostToolNotStartedError } from './host-capabilities.js';
import { createChatUsage } from './usage.js';
import { createRunnerTiming, createRunnerTimingJournal } from '../runner/timing.js';
import { CHECKPOINT_COORDINATION_TOOLS } from './checkpoints.js';
import { registerAgentBrowserRuntime, formatAgentBrowserGuideForTranscript } from '../browser-agent-api.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 48);
export const chatInputMessageId = commandId => commandId.length <= 154 ? `input-${commandId}`
  : `input-${createHash('sha256').update(commandId).digest('hex')}`;
const errorText = error => error instanceof Error ? error.message : String(error);
const crash = (error, failure = {}) => ({ outcome: 'crashed', error: errorText(error), failure });
const present = (callback, payload) => {
  try { callback?.(payload)?.catch?.(() => {}); } catch { /* Viewers never own execution. */ }
};
const approvedOnce = answer => answer === 'allow_once' || answer?.decision === 'allow_once';

/**
 * A server owner around the shared runner. Preparation is injected by the
 * production prompt/context adapter; there is deliberately no fallback prompt.
 * The command service owns admission, lease renewal, terminal settlement and
 * recovery. This owner never takes over an expired lease.
 */
export function createServerChatExecutionHost({
  repository, prepareExecution, resolveCurrentPolicy, createToolDispatch, executeHostTool,
  requestService, authorizeResponse, onEvent, onStatus, hydrateRecoveredQuestions, beforeInference, prepareCheckpoint, prepareWorkspace, prepareNativeExecution, now = Date.now,
} = {}) {
  if (!repository || typeof prepareExecution !== 'function' || typeof resolveCurrentPolicy !== 'function') {
    throw new TypeError('A chat host requires its repository, production preparation and live policy resolver');
  }
  const requests = requestService ?? createChatRequestService({ repository, authorizeResponse, now });
  const active = new Set();

  return {
    supportsSteer: true,
    requests,
    async execute({ command, execution, fence, signal, takeSteers, onEvent: observe } = {}) {
      let checked = validateChatCommand(command);
      if (!checked.ok) return crash(new ChatContractError(checked.error.code, checked.error.message), checked.error);
      command = checked.value;
      if (command.kind !== 'send' || command.chatId !== execution?.chatId || execution.executionId !== fence?.executionId) {
        return crash('Chat execution and input identities do not match', { code: 'ownership_conflict' });
      }
      if (active.has(execution.executionId)) return crash('Chat execution is already active in this host', { code: 'ownership_conflict' });
      const chatId = command.chatId, executionId = execution.executionId;
      const timings = createRunnerTimingJournal();
      const observeTiming = event => {
        timings.record({ ...event, correlationId: executionId });
        const payload = { chatId, executionId, event: { ...event, correlationId: executionId } };
        present(onEvent, payload);
        present(observe, payload);
      };
      const timing = createRunnerTiming(observeTiming);
      const hostStarted = timing.start();
      const abort = new AbortController();
      const combinedSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
      let recoveryError = null;
      let effectsStarted = 0;
      let browserRuntime;
      let checkpoint;
      let nativeExecution;
      const status = value => {
        repository.updateExecution(executionId, { status: value }, { fence });
        present(onStatus, { chatId, executionId, status: value });
      };
      const recovery = error => {
        recoveryError ??= error;
        abort.abort(error);
        return error;
      };
      const waitForHuman = async (input, waitSignal = combinedSignal) => {
        repository.assertFence(chatId, fence);
        const request = requests.open({ ...input, chatId, executionId, fence });
        status(input.kind === 'approval' ? 'waiting_for_approval' : 'waiting_for_input');
        const waiting = timing.start();
        try { return await requests.wait(request.requestId, { signal: waitSignal }); }
        finally {
          timing.end('human_wait', waiting, { category: 'human_wait' });
          if (!combinedSignal.aborted && ['waiting_for_approval', 'waiting_for_input'].includes(repository.getExecution(executionId)?.status)) status('running');
        }
      };

      active.add(executionId);
      try {
        repository.assertFence(chatId, fence);
        const currentExecution = repository.getExecution(executionId);
        if (currentExecution?.status === 'recovery_required') {
          throw recovery(new ChatContractError('recovery_required', 'This execution needs explicit reconciliation before it can continue'));
        }
        if (!currentExecution || ['completed', 'failed', 'stopped'].includes(currentExecution.status)) {
          throw new ChatContractError('ownership_conflict', 'This execution is no longer active');
        }
        if (repository.listUnsettledToolInvocations(executionId).length) {
          throw recovery(new ChatContractError('recovery_required', 'An earlier tool effect has no durable result; verify it before continuing'));
        }
        if (prepareWorkspace) {
          const workspaceStarted = timing.start();
          try {
            const binding = await prepareWorkspace({ command, execution, fence, signal: combinedSignal });
            execution = binding.execution;
          } finally { timing.end('workspace_preparation', workspaceStarted, { category: 'preparation' }); }
        }
        const inputId = chatInputMessageId(command.commandId);
        const priorInput = repository.readMessageByIdentity(chatId, inputId)?.message;
        const createdAt = priorInput ? priorInput.createdAt : command.requestedAt;
        const input = { role: 'user', content: command.message, commandId: command.commandId, provenance: command.provenance,
          ...(typeof createdAt === 'number' ? { createdAt } : {}),
          ...(command.intent?.issue ? { issue: command.intent.issue } : {}),
          ...(command.intent?.codeMap ? { codeMap: command.intent.codeMap } : {}),
          ...(command.intent?.suppressUserEcho ? { hiddenFromTranscript: true } : {}),
          ...(command.images?.length ? { images: command.images } : {}) };
        repository.appendMessage(chatId, input, { fence, commandId: command.commandId, messageId: inputId });
        if (combinedSignal.aborted) return crash(combinedSignal.reason ?? 'Stopped', { code: 'execution_stopped', stopped: true });
        const preparationStarted = timing.start();
        let prepared;
        try { prepared = await prepareExecution({ command, execution, fence, signal: combinedSignal }); }
        finally { timing.end('preparation', preparationStarted, { category: 'preparation' }); }
        if (prepared?.waitingForHost === true || prepared?.missingCapabilities?.length) {
          return crash(prepared.reason ?? 'This execution needs a connected host with the required capabilities', {
            code: 'capability_unavailable', waitingForHost: true,
            requiredCapabilities: prepared.requiredCapabilities ?? prepared.missingCapabilities ?? [],
          });
        }
        if (!prepared?.deps || !prepared.model?.id || !prepared.model?.providerId || !Array.isArray(prepared.tools) ||
            typeof prepared.systemPrompt !== 'string' || !prepared.systemPrompt.trim() || typeof prepared.cwd !== 'string' || !prepared.cwd.trim()) {
          throw new ChatContractError('capability_unavailable', 'Production chat preparation is incomplete');
        }
        const policy = assertChatPolicy(prepared.policy);
        if (prepareCheckpoint) checkpoint = await prepareCheckpoint({ chatId, executionId, cwd: prepared.cwd, fence,
          signal: combinedSignal, onTiming: (stage, duration) => timing.end(`checkpoint_${stage}`, timing.start() - duration, { category: 'checkpoint' }) });
        if (prepared.contextBodies) repository.setTranscriptMeta(chatId, { injectedContext: prepared.contextBodies }, { fence });
        const transcript = createChatTranscriptStore({ repository, chatId, fence, now });
        const runtimeOwner = { chatId, runId: execution.runId ?? executionId, agentId: executionId };
        const dispatchContext = { command, execution, fence, signal: combinedSignal, runtimeOwner };
        if (hydrateRecoveredQuestions) await hydrateRecoveredQuestions({ execution, fence, transcript, signal: combinedSignal, status,
          assertAllowed: async () => assertChatToolAllowed(policy, 'ask_question', {}, {
            currentPolicy: typeof resolveCurrentPolicy === 'function' ? await resolveCurrentPolicy({ ...dispatchContext, prepared }) : policy, approvalGranted: true,
          }) });
        if (beforeInference) await beforeInference({ execution, signal: combinedSignal });
        const dispatch = createToolDispatch
          ? await createToolDispatch(prepared, dispatchContext)
          : createInProcessToolDispatch({ cwd: prepared.cwd, modeId: policy.modeId,
            allowedToolNames: Object.keys(policy.toolPermissions).filter(name => policy.toolPermissions[name] !== 'off'),
            runtimeOwner, activityChatId: chatId });
        if (typeof dispatch?.execute !== 'function' || typeof dispatch.runHeadlessToolBatch !== 'function') {
          throw new ChatContractError('capability_unavailable', 'A real chat tool dispatcher is required');
        }
        const hostTools = new Set(prepared.hostToolNames ?? []);
        if (hostTools.size && typeof executeHostTool !== 'function') {
          return crash('This execution needs a connected host for its offered tools', {
            code: 'capability_unavailable', waitingForHost: true,
            requiredCapabilities: [...hostTools].map(name => `tool:${name}`),
          });
        }
        const dispatchTool = async (name, args, ctx) => {
          const started = timing.start();
          if (!hostTools.has(name)) {
            try { return await dispatch.execute(name, args, { ...ctx, signal: combinedSignal }); }
            finally { timing.end('external_tool_execution', started, { name, id: ctx.toolCallId, category: 'execution' }); }
          }
          if (typeof executeHostTool !== 'function') {
            throw new ChatContractError('capability_unavailable', `Tool ${name} requires a connected execution host`);
          }
          status('waiting_for_host');
          try { return await executeHostTool({ name, args, ctx, chatId, executionId, fence, signal: combinedSignal, prepared,
            revalidate: () => checkTool(name, args, ctx.toolCallId) }); }
          finally {
            timing.end('host_wait', started, { name, id: ctx.toolCallId, category: 'host_wait' });
            if (!combinedSignal.aborted && repository.getExecution(executionId)?.status === 'waiting_for_host') status('running');
          }
        };
        const livePolicy = async () => assertChatPolicy(await resolveCurrentPolicy({ ...dispatchContext, prepared }));
        if (execution.captured?.nativeExecution?.requestedMode === 'native') {
          if (typeof prepareNativeExecution !== 'function' || !checkpoint) throw new ChatContractError('capability_unavailable', 'This host cannot enforce the accepted native-tool selection. No fallback was started.');
          nativeExecution = await prepareNativeExecution({ command, execution, fence, prepared, checkpoint, signal: combinedSignal,
            resolveCurrentPolicy: livePolicy, waitForApproval: (request, signal) => waitForHuman(request, signal) });
        }
        const runnerDeps = { ...prepared.deps,
          postChatCompletions: (provider, body, signal, options) => prepared.deps.postChatCompletions(provider, body,
            nativeExecution ? AbortSignal.any([signal, nativeExecution.signal]) : signal,
            { ...options, ...(nativeExecution ? { nativeExecution, fallbackRole: 'default', exactModel: true } : { minnowOnly: true }) }),
        };
        const approvals = new Map();
        const checkTool = async (name, args, toolCallId) => {
          repository.assertFence(chatId, fence);
          const approvalKey = digest([name, args]);
          try { return assertChatToolAllowed(policy, name, args, { currentPolicy: await livePolicy(), approvalGranted: approvals.get(toolCallId) === approvalKey }); }
          catch (error) {
            if (error?.reason !== 'approval_required') throw error;
            const answer = await waitForHuman({ toolCallId, kind: 'approval', title: `Allow ${name}?`,
              presentation: { toolName: name, arguments: args, workspaceRoot: prepared.cwd } });
            if (!approvedOnce(answer)) throw new ChatContractError('policy_denied', `Approval for ${name} was declined`);
            approvals.set(toolCallId, approvalKey);
            repository.assertFence(chatId, fence);
            return assertChatToolAllowed(policy, name, args, { currentPolicy: await livePolicy(), approvalGranted: true });
          }
        };
        const execute = async (name, rawArgs, ctx) => {
          if (combinedSignal.aborted) throw combinedSignal.reason ?? new DOMException('Stopped', 'AbortError');
          const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
          if (!ctx?.toolCallId) throw new ChatContractError('invalid_request', 'Durable tools require a tool call identity');
          const allowed = await checkTool(name, args, ctx.toolCallId);
          const dispatchContext = { ...ctx, approvalGranted: allowed.permission === 'ask' };
          // No intent exists until an adapter can own this exact call. A
          // connected adapter may wait for reconnection once the intent exists.
          if (hostTools.has(name) && typeof executeHostTool !== 'function') {
            const error = new ChatContractError('capability_unavailable', `Tool ${name} requires a connected execution host`);
            error.waitingForHost = true; error.requiredCapabilities = [`tool:${name}`];
            throw error;
          }
          const effect = allowed.policy.toolEffects[name] ?? 'unknown';
          if (effect === 'read') return dispatchTool(name, args, dispatchContext);
          const detached = args.background === true || name === 'start_background_command' ||
            name === 'manage_dev_servers' && ['start', 'restart'].includes(args.action) ||
            name === 'action_run' && args.location === 'local';
          if (checkpoint && !CHECKPOINT_COORDINATION_TOOLS.has(name) && detached) {
            return { content: 'Error: Background mutations cannot release a safety checkpoint before completion. Run this command in the foreground.' };
          }
          const invoke = async () => {
          // Waiting for a checkout baseline must never preserve a stale grant.
          await checkTool(name, args, ctx.toolCallId);
          const invocationId = `tool-${digest([executionId, ctx.toolCallId])}`;
          let intent;
          try {
            intent = repository.recordToolIntent({ invocationId, chatId, executionId, toolCallId: ctx.toolCallId, toolName: name, input: args }, { fence });
          } catch (error) { throw recovery(error); }
          if (intent.replayed) {
            if (intent.state === 'settled') return intent.result;
            throw recovery(new ChatContractError('recovery_required', 'This tool effect has no confirmed result; it cannot be repeated'));
          }
          effectsStarted++;
          try {
            const result = await dispatchTool(name, args, dispatchContext);
            // Persist the original result before any runner/UI decoration.
            repository.settleToolInvocation(invocationId, result, { fence });
            return result;
          } catch (error) {
            if (isHostToolNotStartedError(error)) {
              const result = { content: `Error: ${errorText(error)}` };
              try {
                repository.settleToolInvocation(invocationId, result, { fence });
                effectsStarted--;
                return result;
              } catch (receiptError) { throw recovery(receiptError); }
            }
            throw recovery(error);
          }
          };
          if (!checkpoint || CHECKPOINT_COORDINATION_TOOLS.has(name)) return invoke();
          try { return await checkpoint.effect(ctx.toolCallId, invoke); }
          catch (error) { throw error?.checkpointUncertain ? recovery(error) : error; }
        };
        const ask = policy.toolPermissions.ask_question && policy.toolPermissions.ask_question !== 'off' ? {
          async ask(question, ctx) {
            if (!ctx.toolCallId) throw new ChatContractError('invalid_request', 'A durable question requires its tool call identity');
            repository.assertFence(chatId, fence);
            // Asking a question is itself the human interaction. Its "ask"
            // permission must not create a second approval before the question.
            assertChatToolAllowed(policy, 'ask_question', {}, { currentPolicy: await livePolicy(), approvalGranted: true });
            return waitForHuman({ toolCallId: ctx.toolCallId, kind: 'question', title: 'Question from agent',
              presentation: { question } }, ctx.signal);
          },
        } : null;
        const usage = createChatUsage({ repository, now,
          readProviderPricing: async providerId => (await prepared.deps.resolveProvider(providerId))?.pricing ?? null });
        let completionIndex = usage.nextRoundIndex(executionId);
        let actualModel = { providerId: prepared.model.providerId, modelId: prepared.model.id };
        if (actualModel.providerId !== 'minnow-router') repository.updateExecutionActivity(executionId, { resolvedModel: actualModel }, { fence });
        if (prepared.tools.some(tool => tool.function?.name === 'browser_reserve_tab')) {
          browserRuntime = await registerAgentBrowserRuntime(runtimeOwner, { kind: 'chat' });
        }
        const providerStarted = timing.start();
        const result = await runTurn({
          ...(prepared.runOptions ?? {}),
          // The accepted input is already canonical, including image policy
          // projection that may differ from command.message on the wire.
          chatId, seed: '', seedKind: 'continue', systemPrompt: prepared.systemPrompt,
          cliTurnContext: prepared.cliTurnContext, tools: prepared.tools, model: prepared.model, cwd: prepared.cwd,
          transcript, deps: { ...runnerDeps, transcriptStore: transcript, runHeadlessToolBatch: dispatch.runHeadlessToolBatch,
            recordTurnUsage: async (_input, turn) => {
              try { await usage.recordRound({ executionId, roundIndex: completionIndex++, fence, turn, modelSelection: actualModel }); }
              catch (error) { throw recovery(error); }
            } },
          signal: combinedSignal, limits: prepared.limits, ask, execute,
          onRoundBoundary: () => {
            const steer = takeSteers?.();
            const messages = [...(Array.isArray(steer) ? steer : steer?.messages ?? [])];
            const rowIds = [...(steer?.rowIds ?? messages.map(() => null))];
            browserRuntime?.drainGuides(guide => {
              const messageId = 'guide-' + guide.id;
              if (repository.readMessageByIdentity(chatId, messageId)) return;
              const message = { role: 'user', content: formatAgentBrowserGuideForTranscript(guide) };
              const row = repository.appendMessage(chatId, message, { fence, messageId });
              messages.push(message);
              rowIds.push(row.rowId);
            });
            return messages.length ? { messages, rowIds } : null;
          },
          onEvent: event => {
            if (event.type === 'runner_timing') { event = { ...event, correlationId: executionId }; timings.record(event); }
            try {
              if (event.type === 'model_selected') {
                actualModel = { providerId: event.providerId, modelId: event.modelId };
                repository.updateExecutionActivity(executionId, { resolvedModel: actualModel }, { fence });
              } else if (event.type === 'context_usage') repository.updateExecutionActivity(executionId,
                { contextUsage: { used: event.used, limit: event.limit, isEstimate: event.isEstimate } }, { fence });
            } catch (error) { recovery(error); }
            present(prepared.onEvent, event);
            present(onEvent, { chatId, executionId, event });
            present(observe, { chatId, executionId, event });
          },
        });
        timing.end('runner_settled', providerStarted, { category: 'settlement' });
        if (checkpoint) {
          try { await checkpoint.finalize(); }
          catch (error) { throw effectsStarted ? recovery(error) : error; }
        }
        if (recoveryError || repository.listUnsettledToolInvocations(executionId).length ||
            (effectsStarted && result.outcome === 'crashed' && result.failure?.code === 'transcript_persistence_failed')) {
          throw recovery(recoveryError ?? new ChatContractError('recovery_required', 'A tool effect needs transcript or result reconciliation'));
        }
        return { ...(combinedSignal.aborted && signal?.aborted
          ? crash(signal.reason ?? 'Stopped', { code: 'execution_stopped', stopped: true }) : result), timings: timings.report };
      } catch (error) {
        const needsRecovery = recoveryError || error?.code === 'recovery_required' || error?.checkpointUncertain ||
          repository.listUnsettledToolInvocations(executionId).length;
        if (needsRecovery) {
          // Keep the barrier even if a report was captured, or the provider
          // returned a plausible success after the effect receipt failed.
          try { status('recovery_required'); } catch { /* A lost fence cannot be replaced here. */ }
          return { ...crash(recoveryError ?? error, { code: 'recovery_required', recoveryRequired: true }), timings: timings.report };
        }
        return { ...crash(error, { code: error?.code ?? 'internal_error',
          ...(error?.waitingForHost === true ? { waitingForHost: true, requiredCapabilities: error.requiredCapabilities ?? [] } : {}),
          ...(signal?.aborted ? { stopped: true } : {}) }), timings: timings.report };
      } finally {
        timing.end('host_execution', hostStarted, { category: 'execution' });
        browserRuntime?.close();
        nativeExecution?.dispose();
        active.delete(executionId);
        requests.expireExecution(executionId, chatId, combinedSignal.aborted ? 'cancelled' : 'expired');
      }
    },
  };
}
