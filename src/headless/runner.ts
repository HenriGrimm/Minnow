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
import { createGeneration, subscribeToGeneration } from '../api/generations';
import { initHeadlessWorkAgents } from './init-work-agents';
import { resolveActiveWorkAgent } from '../agents/resolve-work-agent';
import { resolveWorkAgentBinding } from '../agents/resolve-work-agent-binding';
import { getUserWorkAgentOverride } from '../agents/work-agent-registry';
import { WorkAgentConfigError } from '../agents/work-agent-types';
import { applySamplerToBody } from '../agents/sampler-types';
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
import { parseToolArguments } from '../tools/parse-tool-arguments';
import { runHeadlessToolBatch } from '../tools/headless-tool-batch';
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
  previewToolResult,
  serializeHeadlessRunResult,
  type HeadlessRunResult,
  type HeadlessTurnRecord,
} from './result';
import { installHeadlessFetch, installHeadlessLocalStorage, resolveHeadlessToken } from './server-context';
import { persistHeadlessChat } from './persist-chat';

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

async function streamHeadlessTurn(
  providerId: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{
  fullText: string;
  finishReason: string | undefined;
  toolCalls: ReturnType<typeof finalizeToolCalls>;
  generationId: string;
}> {
  const { generationId } = await createGeneration(providerId, body, { persist: false, fallbackRole: 'default' });

  let fullText = '';
  let streamMeta: StreamMetaAccumulator = {};
  let toolAcc: ToolCallAccumulator = {};

  function handleChunk(chunk: ChatCompletionChunk): void {
    streamMeta = mergeStreamMeta(streamMeta, chunk);
    toolAcc = mergeToolCallDelta(toolAcc, chunk);
    const delta = extractStreamDelta(chunk);
    if (delta) fullText += delta;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const unsubscribe = subscribeToGeneration(generationId, {
      signal,
      onChunk: handleChunk,
      onEnd: () => finish(resolve),
      onTransportError: (err) => {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      },
    });

    signal.addEventListener(
      'abort',
      () => {
        unsubscribe();
        finish(() => reject(new DOMException('Aborted', 'AbortError')));
      },
      { once: true },
    );
  });

  const finishReason =
    streamMeta.finish_reason ||
    (Object.keys(toolAcc).length > 0 ? 'tool_calls' : 'stop');

  return {
    fullText,
    finishReason,
    toolCalls: finalizeToolCalls(toolAcc),
    generationId,
  };
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
}

/** Run one headless agent turn; caller handles exit code from result.exitCode. */
export async function runHeadless(options: RunHeadlessOptions): Promise<HeadlessRunResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  installHeadlessLocalStorage();
  installHeadlessFetch(options.cli.baseUrl, resolveHeadlessToken(options.cli.token));

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

    for (let turn = 0; ; turn++) {
      if (turn > 0) {
        enabledTools = await getHeadlessToolsWithMcp(modeId);
        if (activeWorkAgent?.allowedTools?.length) {
          const allow = new Set(activeWorkAgent.allowedTools);
          enabledTools = enabledTools.filter(t => t.function.name.startsWith('mcp__') || allow.has(t.function.name));
        }
      }
      if (options.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      const composedSystem = [outbound.composed, schedulerSystemNote]
        .filter((part) => part.trim())
        .join('\n\n');

      const messages: ApiMessage[] = buildHeadlessApiMessages(
        chat,
        composedSystem,
        outbound.userRules ?? undefined,
      );

      const body = applySamplerToBody(
        {
          model: sendModelId,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          tools: enabledTools.length > 0 ? enabledTools : undefined,
          tool_choice: enabledTools.length > 0 ? ('auto' as const) : undefined,
        },
        resolvedSampler.preset,
        resolvedSampler.maxTokens,
      );

      const turnResult = await streamHeadlessTurn(
        sendProviderId,
        body as unknown as Record<string, unknown>,
        options.signal,
      );
      const turnRecord: HeadlessTurnRecord = {
        generationId: turnResult.generationId,
        finishReason: turnResult.finishReason ?? null,
        assistantText: turnResult.fullText,
        toolCalls: [],
      };

      if (turnResult.toolCalls.length === 0) {
        assistantFinal = turnResult.fullText.trim();
        chat.history.push({ role: 'assistant', content: assistantFinal });
        turns.push(turnRecord);
        ok = true;
        exitCode = 0;
        break;
      }

      chat.history.push({
        role: 'assistant',
        content: turnResult.fullText || null,
        tool_calls: turnResult.toolCalls,
      });

      const outcomes = await runHeadlessToolBatch({
        toolCalls: turnResult.toolCalls,
        execute: async (name, args) => {
          const result = await executeHeadlessTool(
            name,
            args as Record<string, unknown>,
            {
              modeId,
              workAgentId: workAgentId ?? undefined,
              chatId: chat.id,
            },
            approvalOpts,
          );

          if (
            result.content.startsWith('Error: tool ') &&
            result.content.includes('requires user approval')
          ) {
            throw new Error(result.content);
          }
          if (result.content.startsWith('Error: --no-approval requires')) {
            throw new Error(result.content);
          }

          return result;
        },
      });

      for (const outcome of outcomes) {
        const tc = outcome.toolCall;
        const { args } = parseToolArguments(tc.function.arguments);
        const content = outcome.parseError ?? outcome.result?.content ?? '';
        turnRecord.toolCalls.push({
          name: tc.function.name,
          args,
          resultPreview: previewToolResult(content),
        });
        chat.history.push({
          role: 'tool',
          tool_call_id: tc.id,
          content,
        });
      }

      turns.push(turnRecord);
    }

    if (!ok) {
      throw new Error('Run ended without a final assistant message');
    }
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e?.name === 'AbortError') {
      error = 'Interrupted (SIGINT)';
      exitCode = 130;
    } else {
      error = e?.message ?? String(err);
      exitCode = 1;
    }
    log(error);
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
