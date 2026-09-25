import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getMinnowHome } from '../../config/home.js';
import { appendChunk, markComplete, markError, markStreaming, noteGenerationCandidateChosen, NON_AGENT_FALLBACK_ROLES } from '../store.js';
import { generationTimeoutMessage } from '../timeouts.js';
import { admitAgentCli } from './admission.js';
import { createAgentCliBridge, buildAgentCliToolCatalog } from './bridge.js';
import { createJsonlDecoder } from './jsonl.js';
import { buildAgentCliPrompt } from './prompt.js';
import { createAgentCliTranslator } from './translate.js';
import { classifyAgentCliFailure, safeAgentCliDiagnostic } from './errors.js';
import { prepareAgentCliInvocation as defaultPrepareInvocation } from './invocation.js';
import { spawnAgentCli as defaultSpawn } from './spawn.js';
import { pumpAgentCliSession } from './session.js';

let prepareInvocation = defaultPrepareInvocation;
let spawn = defaultSpawn;
const UTILITY_ROLES = new Set([...NON_AGENT_FALLBACK_ROLES, 'context-summarize', 'memory-synthesis', 'brain-synthesis']);
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TOOL_BATCH_QUIET_MS = 200;

export function __setAgentCliPumpMocksForTests(mocks = {}) {
  prepareInvocation = mocks.prepareInvocation ?? defaultPrepareInvocation;
  spawn = mocks.spawn ?? defaultSpawn;
}

export function __resetAgentCliPumpMocksForTests() {
  prepareInvocation = defaultPrepareInvocation;
  spawn = defaultSpawn;
}

export function agentCliRoleAllowed(state, settings) {
  if (settings.allowUtilityRoles === true) return true;
  if (UTILITY_ROLES.has(state.fallbackRole)) return false;
  return !!state.fallbackRole || state.persist === true;
}

/** CLI response rounds end before Minnow executes a handed-off tool. */
export async function pumpAgentCliUpstream({ state, runtime, candidate, index, idleMs, maxMs, canFailover }) {
  if (state.status === 'cancelled') return { outcome: 'complete' };
  const settings = runtime.profile.agentCli ?? {};
  if (!agentCliRoleAllowed(state, settings)) return { outcome: 'retry', retrySameCandidate: false, hostSuspect: false, message: 'Background use of this CLI is off. Enable it in Models → CLIs or select another model for this role.' };
  if (state.chatId && prepareInvocation === defaultPrepareInvocation && spawn === defaultSpawn) {
    return pumpAgentCliSession({ state, runtime, candidate, index, idleMs, maxMs, canFailover });
  }
  const controller = new AbortController();
  state.upstreamController = controller;
  let release;
  let tempDir;
  let bridge;
  let processRun;
  let invocation;
  let idleTimer;
  let maxTimer;
  let handoffTimer;
  let timeoutKind;
  let failure;
  const handedOff = [];
  let handoffClosed = false;
  let emitted = false;
  let stopping;
  let content = '';
  let reasoning = '';
  let outputBytes = 0;
  const secretValues = Object.values(runtime.secrets ?? {}).filter(value => typeof value === 'string');
  const stop = () => {
    if (!stopping && processRun) stopping = processRun.stop();
    return stopping ?? Promise.resolve();
  };
  const abort = () => { void stop().catch(() => {}); };
  controller.signal.addEventListener('abort', abort, { once: true });
  const rearmIdle = () => {
    clearTimeout(idleTimer);
    if (idleMs > 0) idleTimer = setTimeout(() => { timeoutKind = 'idle'; controller.abort(); }, idleMs);
  };
  function choose() {
    if (emitted) return;
    emitted = true;
    noteGenerationCandidateChosen(state, { providerId: candidate.providerId, modelId: candidate.modelId, index });
  }
  function append(payload) { appendChunk(state, Buffer.from(`data: ${JSON.stringify(payload)}\n\n`, 'utf8')); }
  try {
    if (maxMs > 0) maxTimer = setTimeout(() => { timeoutKind = 'max'; controller.abort(); }, maxMs);
    release = await admitAgentCli(candidate.providerId, settings.maxConcurrent, controller.signal);
    if (controller.signal.aborted) throw Object.assign(new Error('Agent CLI cancelled.'), { name: 'AbortError' });
    const body = JSON.parse(state.requestBody.toString('utf8'));
    body.model = candidate.modelId;
    if (body.n != null && body.n !== 1) throw new Error('Agent CLI supports one response per request.');
    const tools = buildAgentCliToolCatalog(body);
    const replay = buildAgentCliPrompt(body, settings.kind);
    const root = join(getMinnowHome(), 'tmp', 'agent-cli');
    await mkdir(root, { recursive: true, mode: 0o700 });
    tempDir = await mkdtemp(join(root, 'generation-'));
    bridge = await createAgentCliBridge({ tools, tempDir, onCall: call => {
      if (controller.signal.aborted || handoffClosed || failure) return;
      const callIndex = handedOff.push(call) - 1;
      choose();
      // Keep a brief window for parallel requests from the same model response.
      // Minnow executes none of them until the CLI process has exited.
      if (body.stream !== false) {
        append({ choices: [{ index: 0, delta: { tool_calls: [{ index: callIndex, ...call }] } }] });
      }
      clearTimeout(handoffTimer);
      handoffTimer = setTimeout(() => {
        handoffClosed = true;
        void stop().catch(error => { failure = error; });
      }, TOOL_BATCH_QUIET_MS);
    } });
    secretValues.push(bridge.config.env.MINNOW_CLI_BRIDGE_TOKEN);
    invocation = await prepareInvocation({
      kind: settings.kind, profile: settings, body: { ...body, agentCliImages: replay.images },
      tempDir, prompt: replay.prompt, systemPrompt: replay.systemPrompt, bridgeConfig: bridge.config,
      secrets: runtime.secrets, signal: controller.signal,
    });
    for (const [key, value] of Object.entries(invocation.env ?? {})) {
      if (/(?:token|api_?key|password|authorization)/i.test(key) && typeof value === 'string') secretValues.push(value);
    }
    if (controller.signal.aborted) throw Object.assign(new Error('Agent CLI cancelled.'), { name: 'AbortError' });
    const translator = createAgentCliTranslator(settings.kind, delta => {
      if (controller.signal.aborted || handedOff.length > 0 || failure) return;
      if (delta.forbiddenTool) {
        failure = new Error(`Agent CLI attempted a native tool (${delta.forbiddenTool}). Only Minnow tools are allowed.`);
        void stop();
        return;
      }
      if (delta.content) content += delta.content;
      if (delta.reasoning) reasoning += delta.reasoning;
      if (body.stream !== false) {
        choose();
        if (delta.activity) {
          append({ choices: [{ index: 0, delta: {} }], minnow_agent_cli: delta.activity });
        } else {
          append({ choices: [{ index: 0, delta }] });
        }
      }
    });
    const decoder = createJsonlDecoder({ onEvent: event => {
      translator.consume(event);
      if (translator.snapshot().terminal) void stop().catch(error => { failure = error; });
    } });
    markStreaming(state);
    processRun = spawn(invocation);
    rearmIdle();
    processRun.child.stdout.on('data', chunk => {
      if (failure || handedOff.length > 0 || controller.signal.aborted) return;
      try {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) throw new Error('Agent CLI output exceeded 16 MB.');
        rearmIdle();
        decoder.write(chunk);
      } catch (error) { failure = error; void stop(); }
    });
    const exit = await processRun.done;
    if (stopping) await stopping;
    if (handedOff.length === 0 && !failure && !controller.signal.aborted) decoder.end();
    if (state.status === 'cancelled') return { outcome: 'complete' };
    if (state.status === 'error') return { outcome: 'fatal', message: state.errorMessage, hostSuspect: false };
    if (timeoutKind) throw new Error(generationTimeoutMessage({ idleMs, maxMs }, timeoutKind));
    if (controller.signal.aborted) throw new Error('Agent CLI request cancelled.');
    const snapshot = translator.snapshot();
    if (handedOff.length === 0) {
      const classified = classifyAgentCliFailure({ error: failure, terminal: snapshot.terminal, exitCode: exit.code, stderr: safeAgentCliDiagnostic(exit.stderr, secretValues) });
      if (classified) {
        const error = new Error(classified.message);
        error.retryable = classified.kind === 'retryable';
        throw error;
      }
      if (body.tool_choice === 'required' || body.tool_choice?.function?.name) throw new Error('Agent CLI completed without calling the required tool.');
    } else if (failure) throw failure;
    await stop();
    await bridge.close();
    bridge = null;
    if (state.status === 'cancelled') return { outcome: 'complete' };
    choose();
    const finishReason = handedOff.length > 0 ? 'tool_calls' : snapshot.terminal?.finishReason ?? 'stop';
    const metadata = { ...(snapshot.usage ? { usage: snapshot.usage } : {}), ...(snapshot.cost != null ? { minnow_cli: { cost_usd: snapshot.cost } } : {}) };
    if (body.stream !== false) {
      append({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }], ...metadata });
      appendChunk(state, Buffer.from('data: [DONE]\n\n'));
    } else {
      appendChunk(state, Buffer.from(JSON.stringify({
        id: state.id, object: 'chat.completion', model: candidate.modelId,
        choices: [{ index: 0, message: { role: 'assistant', content: content || null, ...(reasoning ? { reasoning } : {}), ...(handedOff.length > 0 ? { tool_calls: handedOff } : {}) }, finish_reason: finishReason }],
        ...metadata,
      })));
    }
    markComplete(state);
    return { outcome: 'complete' };
  } catch (error) {
    if (state.status === 'cancelled') return { outcome: 'complete' };
    const classified = classifyAgentCliFailure({ error });
    const message = safeAgentCliDiagnostic(classified.message, secretValues);
    const retryable = !emitted && handedOff.length === 0 && (error.retryable || classified.kind === 'retryable' || timeoutKind);
    if (retryable && canFailover) return { outcome: 'retry', message, retrySameCandidate: false, hostSuspect: false };
    markError(state, message);
    return { outcome: 'fatal', message, hostSuspect: false };
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    clearTimeout(handoffTimer);
    controller.signal.removeEventListener('abort', abort);
    await stop().catch(() => {});
    await bridge?.close().catch(() => {});
    if (invocation?.cleanup) await invocation.cleanup().catch(() => {});
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    release?.();
    if (state.upstreamController === controller) state.upstreamController = null;
  }
}
