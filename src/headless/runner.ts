/**
 * Headless agent run loop — generations + server tools, no DOM.
 */

import {
  extractStreamDelta,
  finalizeToolCalls,
  mergeStreamMeta,
  mergeToolCallDelta,
  parseSsePayloads,
  type StreamMetaAccumulator,
} from '../api/chat';
import { cancelGeneration, createGeneration, subscribeToGeneration, type GenerationEndEvent } from '../api/generations';
import { HeadlessGenerationError, headlessGenerationFailure } from './generation-terminal';
import { initHeadlessWorkAgents } from './init-work-agents';
import { resolveActiveWorkAgent } from '../agents/resolve-work-agent';
import { resolveWorkAgentBinding } from '../agents/resolve-work-agent-binding';
import { getUserWorkAgentOverride } from '../agents/work-agent-registry';
import { WorkAgentConfigError } from '../agents/work-agent-types';
import { resolveHeadlessTurnSampler } from './resolve-turn-sampler';
import { resolveHeadlessOutboundSystemMessages } from './resolve-prompt';
import { buildHeadlessApiMessages } from './build-messages';
import { normalizeModeId, type ModeId } from '../chat/modes/types';
import {
  loadChatMeta,
} from '../config/chat-meta';
import {
  loadSamplerMeta,
} from '../config/sampler-meta';
import {
  loadPromptMetaSettings,
  setPromptMetaCacheForTests,
  type PromptProfileName,
} from '../config/prompt-meta';
import { detectConfigServer, isServerStorageMode } from '../config/storage-mode';
import { getActiveProvider } from '../providers/store';
import { detectLocalServer } from '../tools/client';
import {
  ensureToolConfigReady,
  isToolConfigReadyForSettingsUi,
} from '../tools/config';
import type { ApiMessage, Chat, ChatCompletionChunk, ToolCallAccumulator } from '../types';
import type { HeadlessRunCliOptions } from './argv';
import {
  executeHeadlessTool,
  getHeadlessToolsWithMcp,
} from './execute-tool';
import {
  HEADLESS_RESULT_VERSION,
  serializeHeadlessRunResult,
  type HeadlessRunResult,
  type HeadlessTurnRecord,
} from './result';
import { installHeadlessFetch, installHeadlessLocalStorage, resolveHeadlessToken } from './server-context';
import { persistHeadlessChat } from './persist-chat';
import { createHeadlessRunnerDeps } from './runner-deps';
import { HEADLESS_CONTEXT_TOKENS, runHeadlessSharedTurn } from './shared-turn';
import type { TranscriptMessage } from '../../server/runner/transcript-store';
import { resolveChatContextBudget } from '../chat/context/chat-context-budget';

/** Apply --profile in memory only (does not write ~/.minnow). */
async function loadPromptMetaWithProfile(profile: string): Promise<void> {
  const base = await loadPromptMetaSettings();
  let activePromptProfile: PromptProfileName = 'full';
  let activePromptConfigId: string | null = null;
  if (profile === 'lite') {
    activePromptProfile = 'lite';
  } else if (profile.startsWith('custom:')) {
    activePromptProfile = 'custom';
    activePromptConfigId = profile.slice('custom:'.length).trim() || null;
  }
  setPromptMetaCacheForTests({ ...base, activePromptProfile, activePromptConfigId });
}

/** @internal Exposed for generation transport regression tests. */
export interface ActiveHeadlessGeneration {
  generationId: string;
  cancel: () => Promise<void>;
}

/** Streaming generations adapter for the shared core, preserving terminal text. */
export async function postHeadlessTurn(
  providerId: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onGenerationChange?: (active: ActiveHeadlessGeneration | null) => void,
  onFailure?: (error: HeadlessGenerationError) => void,
): Promise<Response> {
  const { generationId } = await createGeneration(providerId, body, { persist: false, fallbackRole: 'default' });
  let cancellation: Promise<void> | null = null;
  const cancel = () => cancellation ??= cancelGeneration(generationId).catch(() => {});
  let unsubscribe = (): void => {};
  let settled = false;
  let partialText = '';
  let abort = (): void => {};
  const cleanup = () => {
    if (settled) return;
    settled = true;
    unsubscribe();
    signal.removeEventListener('abort', abort);
    onGenerationChange?.(null);
  };
  onGenerationChange?.({ generationId, cancel });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const fail = (error: HeadlessGenerationError) => {
        if (settled) return;
        onFailure?.(error);
        cleanup();
        controller.error(error);
      };
      abort = () => {
        void cancel();
        fail(new HeadlessGenerationError('cancelled', partialText, generationId, 'Generation cancelled'));
      };
      unsubscribe = subscribeToGeneration(generationId, {
        signal,
        onChunk: chunk => {
          if (settled) return;
          partialText += extractStreamDelta(chunk);
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
        },
        onEnd: event => {
          if (settled) return;
          const failure = headlessGenerationFailure(event, partialText, generationId);
          if (failure) { fail(failure); return; }
          cleanup();
          controller.close();
        },
        onTransportError: error => {
          void cancel();
          fail(new HeadlessGenerationError('error', partialText, generationId, error instanceof Error ? error.message : String(error)));
        },
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    },
    cancel() {
      cleanup();
      return cancel();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

export async function streamHeadlessTurn(
  providerId: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onGenerationChange?: (active: ActiveHeadlessGeneration | null) => void,
): Promise<{
  fullText: string;
  finishReason: string | undefined;
  toolCalls: ReturnType<typeof finalizeToolCalls>;
  generationId: string;
}> {
  const { generationId } = await createGeneration(providerId, body, { persist: false, fallbackRole: 'default' });
  let cancellation: Promise<void> | null = null;
  const cancelOnce = (): Promise<void> => {
    if (!cancellation) cancellation = cancelGeneration(generationId).catch(() => {});
    return cancellation;
  };

  let fullText = '';
  let streamMeta: StreamMetaAccumulator = {};
  let toolAcc: ToolCallAccumulator = {};
  let terminalEvent: GenerationEndEvent | undefined;

  function handleChunk(chunk: ChatCompletionChunk): void {
    streamMeta = mergeStreamMeta(streamMeta, chunk);
    toolAcc = mergeToolCallDelta(toolAcc, chunk);
    const delta = extractStreamDelta(chunk);
    if (delta) fullText += delta;
  }

  try {
    onGenerationChange?.({ generationId, cancel: cancelOnce });
    if (signal.aborted) {
      throw new HeadlessGenerationError('cancelled', '', generationId, 'Generation cancelled');
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let unsubscribe = (): void => {};
      const onAbort = (): void => {
        unsubscribe();
        void cancelOnce();
        finish(() => reject(new HeadlessGenerationError('cancelled', fullText, generationId, 'Generation cancelled')));
      };
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        fn();
      };

      unsubscribe = subscribeToGeneration(generationId, {
        signal,
        onChunk: handleChunk,
        onEnd: (event) => {
          terminalEvent = event;
          finish(resolve);
        },
        onTransportError: (err) => {
          const message = err instanceof Error ? err.message : String(err);
          finish(() => reject(new HeadlessGenerationError('error', fullText, generationId, message)));
        },
      });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });

    const failure = headlessGenerationFailure(terminalEvent, fullText, generationId);
    if (failure) throw failure;

    const finishReason =
      streamMeta.finish_reason ||
      (Object.keys(toolAcc).length > 0 ? 'tool_calls' : 'stop');

    return {
      fullText,
      finishReason,
      toolCalls: finalizeToolCalls(toolAcc),
      generationId,
    };
  } finally {
    // Disconnecting a subscriber never stops a backend-owned generation.
    if (!terminalEvent) await cancelOnce();
    onGenerationChange?.(null);
  }
}

function buildHeadlessChat(options: HeadlessRunCliOptions, workspacePath: string): Chat {
  const now = Date.now();
  const chatId = options.chatId?.trim() || `headless-${now}`;
  return {
    id: chatId,
    name: options.chatName?.trim() || 'Headless run',
    workspacePath,
    modelId: options.modelId ?? '',
    providerId: options.providerId ?? undefined,
    modeId: normalizeModeId(options.modeId) as ModeId,
    workAgentId: options.agentId,
    workAgentAuto: !options.agentId,
    history: [{ role: 'user', content: options.prompt }],
    lastStats: null,
    modelInfo: {},
    updatedAt: now,
  };
}

export interface RunHeadlessOptions {
  cli: HeadlessRunCliOptions;
  workspaceAbs: string | null;
  signal: AbortSignal;
  log?: (line: string) => void;
  onGenerationChange?: (active: ActiveHeadlessGeneration | null) => void;
}

/** Run one headless agent turn; caller handles exit code from result.exitCode. */
export async function runHeadless(options: RunHeadlessOptions): Promise<HeadlessRunResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  installHeadlessLocalStorage();
  installHeadlessFetch(options.cli.baseUrl, resolveHeadlessToken(options.cli.token), options.workspaceAbs ?? '');

  await detectConfigServer();
  await detectLocalServer();
  await initHeadlessWorkAgents();
  await loadChatMeta();
  await loadSamplerMeta();
  await loadPromptMetaWithProfile(options.cli.profile);
  await ensureToolConfigReady();
  if (isServerStorageMode() && !isToolConfigReadyForSettingsUi()) {
    throw new Error(
      'Could not load tool settings from ~/.minnow. Ensure npm start is running and /api/config/tools is reachable.',
    );
  }

  const workspacePath = options.workspaceAbs ?? '';
  const chat = buildHeadlessChat(options.cli, workspacePath);

  if (options.cli.agentId) {
    chat.workAgentId = options.cli.agentId;
    chat.workAgentAuto = false;
  }

  const turns: HeadlessTurnRecord[] = [];
  let assistantFinal = '';
  let error: string | null = null;
  let ok = false;
  let exitCode = 1;
  let providerId = '';
  let modelId = '';
  let workAgentId: string | null = null;
  let persistedChatId: string | null = null;

  try {
    if (options.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const activeWorkAgent = resolveActiveWorkAgent(chat);
    workAgentId = activeWorkAgent?.id ?? null;

    const sendProvider = await getActiveProvider(
      options.cli.providerId ?? chat.providerId,
    );
    let sendModelId = options.cli.modelId ?? chat.modelId;
    let sendProviderId = options.cli.providerId ?? sendProvider.id;

    try {
      const binding = await resolveWorkAgentBinding(
        activeWorkAgent,
        chat,
        { providerId: sendProvider.id, modelId: sendModelId },
        {
          userOverride: activeWorkAgent
            ? getUserWorkAgentOverride(activeWorkAgent.id)
            : undefined,
        },
      );
      sendModelId = binding.modelId;
      sendProviderId = binding.providerId;
    } catch (err) {
      if (err instanceof WorkAgentConfigError) {
        throw new Error(err.message);
      }
      throw err;
    }

    if (!sendModelId) {
      throw new Error(
        'No model configured. Set --model or configure a work agent / active provider model.',
      );
    }

    providerId = sendProviderId;
    modelId = sendModelId;
    chat.providerId = sendProviderId;
    chat.modelId = sendModelId;

    const outbound = await resolveHeadlessOutboundSystemMessages(chat, options.cli.profile);
    const schedulerSystemNote = options.cli.schedulerRun
      ? [
          'You are executing a Minnow scheduled job in headless mode.',
          'Server tools (read/write files, shell, git, search, etc.) are available via the local tool API.',
          'Do not call save_memory to record routine run output — the scheduler stores run history automatically.',
          'Only use save_memory when the job prompt explicitly asks you to remember something for future chats.',
        ].join(' ')
      : '';

    const modeId = normalizeModeId(chat.modeId);
    const resolvedSampler = resolveHeadlessTurnSampler(activeWorkAgent?.id ?? null);

    let enabledTools = await getHeadlessToolsWithMcp(modeId);
    if (activeWorkAgent?.allowedTools?.length) {
      const allow = new Set(activeWorkAgent.allowedTools);
      enabledTools = enabledTools.filter((t) => (t.function.name.startsWith('mcp__') || allow.has(t.function.name)));
    }

    const approvalOpts = {
      noApproval: options.cli.noApproval,
      modeId,
      autoRejectQuestions: options.cli.autoRejectQuestions,
    };

    const composedSystem = [outbound.composed, schedulerSystemNote]
      .filter(part => part.trim()).join('\n\n');
    const messages = buildHeadlessApiMessages(chat, composedSystem, outbound.userRules ?? undefined);
    let generationFailure: HeadlessGenerationError | null = null;
    const deps = createHeadlessRunnerDeps(async (provider, body, signal, postOptions) => {
      generationFailure = null;
      return postHeadlessTurn(provider.id, body, signal, active => {
          if (active) postOptions?.onGenerationId?.(active.generationId);
          options.onGenerationChange?.(active);
      }, error => { generationFailure = error; });
    });
    const contextBudget = resolveChatContextBudget(chat);
    const shared = await runHeadlessSharedTurn({
      chatId: chat.id,
      messages: messages as unknown as TranscriptMessage[],
      systemPrompt: composedSystem,
      model: {
        providerId: sendProviderId,
        id: sendModelId,
        sampler: { preset: { ...resolvedSampler.preset }, maxTokens: resolvedSampler.maxTokens },
      },
      tools: enabledTools,
      signal: options.signal,
      deps,
      limits: {
        contextBudget: {
          ...contextBudget,
          workingContextTokens: contextBudget.workingContextTokens || HEADLESS_CONTEXT_TOKENS,
        },
      },
      refreshTools: async () => {
        let tools = await getHeadlessToolsWithMcp(modeId);
        if (activeWorkAgent?.allowedTools?.length) {
          const allow = new Set(activeWorkAgent.allowedTools);
          tools = tools.filter(tool => tool.function.name.startsWith('mcp__') || allow.has(tool.function.name));
        }
        return tools;
      },
      execute: async (name, args, signal, toolCallId) => {
        const result = await executeHeadlessTool(name, args as Record<string, unknown>, {
          modeId, workAgentId: workAgentId ?? undefined, chatId: chat.id,
          toolCallId, workspaceRoot: workspacePath,
        }, approvalOpts, signal);
        if ((result.content.startsWith('Error: tool ') && result.content.includes('requires user approval')) ||
            result.content.startsWith('Error: --no-approval requires')) {
          throw new Error(result.content);
        }
        return result;
      },
    });
    chat.history = shared.history as unknown as Chat['history'];
    turns.push(...shared.turns);
    assistantFinal = shared.assistantFinal;
    const terminalFailure = generationFailure as HeadlessGenerationError | null;
    if (options.signal.aborted) {
      if (terminalFailure) throw terminalFailure;
      throw new DOMException('Aborted', 'AbortError');
    }
    if (shared.result.outcome === 'timeout') {
      if (terminalFailure) {
        throw new HeadlessGenerationError('error', terminalFailure.partialText, terminalFailure.generationId, 'Headless execution limit exceeded');
      }
      throw new Error('Headless execution limit exceeded');
    }
    if (terminalFailure) throw terminalFailure;
    if (shared.result.outcome === 'crashed') throw new Error(shared.result.error);
    ok = true;
    exitCode = 0;

  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (err instanceof HeadlessGenerationError) {
      assistantFinal = err.partialText.trim();
      if (assistantFinal) chat.history.push({ role: 'assistant', content: assistantFinal });
      const failedTurn = { generationId: err.generationId, finishReason: null, assistantText: err.partialText, toolCalls: [] };
      if (turns.at(-1)?.generationId === err.generationId) turns[turns.length - 1] = failedTurn;
      else turns.push(failedTurn);
      error = err.message;
      exitCode = err.status === 'cancelled' ? 130 : 1;
    } else if (e?.name === 'AbortError') {
      error = 'Interrupted (SIGINT)';
      exitCode = 130;
    } else {
      error = e?.message ?? String(err);
      exitCode = 1;
    }
    log(error ?? 'Headless run failed');
  }

  if (options.cli.persistChat && options.cli.chatId) {
    try {
      await persistHeadlessChat({
        chatId: chat.id,
        chatName: chat.name,
        workspacePath: chat.workspacePath,
        modeId: normalizeModeId(chat.modeId),
        providerId,
        modelId,
        workAgentId,
        history: chat.history,
      });
      persistedChatId = chat.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Failed to persist chat: ${message}`);
    }
  }

  const finishedAt = new Date().toISOString();
  const result: HeadlessRunResult = {
    version: HEADLESS_RESULT_VERSION,
    ok,
    exitCode,
    startedAt,
    finishedAt,
    workspace: options.workspaceAbs,
    modeId: options.cli.modeId,
    workAgentId,
    providerId,
    modelId,
    promptProfile: options.cli.profile,
    userPrompt: options.cli.prompt,
    assistantFinal,
    turns,
    stats: {
      toolRounds: turns.length,
      durationMs: Date.now() - t0,
    },
    error,
    chatId: persistedChatId,
  };

  return result;
}

export { serializeHeadlessRunResult };
