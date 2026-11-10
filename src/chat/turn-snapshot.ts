import { normalizeModeId } from './modes/types';
import { indexOfLastUserMessage } from './history-truncate-core';
import type { ThinkingResolvedMode } from '../agents/thinking-types';
import type { Chat, ReasoningEffortOption, TurnSnapshot } from '../types';
import type { ExpertSelection } from '../types';

export interface BuildTurnSnapshotParams {
  chat: Chat;
  forkHistoryIndex: number;
  composedSystemPrompt: string;
  userRulesContent?: string;
  enabledToolNames: string[];
  providerId: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
  thinkingMode: ThinkingResolvedMode;
  reasoningEffort?: ReasoningEffortOption;
  cliFastMode?: boolean;
  skillId: string | null;
  userContent: string;
}

/** SHA-256 hex digest of a string (browser or Node Web Crypto). */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  if (typeof crypto !== 'undefined' && crypto.subtle?.digest) {
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return `fallback_${hash.toString(16)}`;
}

async function hashHistoryPrefix(
  chat: Chat,
  forkHistoryIndex: number,
): Promise<string> {
  const slice = chat.history.slice(0, forkHistoryIndex + 1);
  return sha256Hex(JSON.stringify(slice));
}

/** Build an immutable snapshot for fork/replay. */
export async function buildTurnSnapshot(
  params: BuildTurnSnapshotParams,
): Promise<TurnSnapshot> {
  const {
    chat,
    forkHistoryIndex,
    composedSystemPrompt,
    userRulesContent,
    enabledToolNames,
    providerId,
    modelId,
    temperature,
    maxTokens,
    skillId,
    userContent,
  } = params;

  const historyPrefixHash = await hashHistoryPrefix(chat, forkHistoryIndex);

  const expertSelection: ExpertSelection | undefined = chat.expertSelection
    ? { ...chat.expertSelection }
    : undefined;

  return {
    forkHistoryIndex,
    userContent,
    skillId,
    providerId,
    modelId,
    temperature,
    maxTokens,
    thinkingMode: params.thinkingMode,
    ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
    ...(params.cliFastMode ? { cliFastMode: true } : {}),
    modeId: normalizeModeId(chat.modeId),
    workAgentId: chat.workAgentId ?? null,
    workAgentAuto: chat.workAgentAuto !== false,
    ...(expertSelection ? { expertSelection } : {}),
    ...(chat.uiDesignerMode ? { uiDesignerMode: chat.uiDesignerMode } : {}),
    composedSystemPrompt,
    ...(userRulesContent ? { userRulesContent } : {}),
    enabledToolNames: [...enabledToolNames],
    historyPrefixHash,
    ...(chat.orchestratePlanPath ? { orchestratePlanPath: chat.orchestratePlanPath } : {}),
  };
}

/** Resolve fork index after pushUser handling. */
export function resolveForkHistoryIndex(chat: Chat, pushUser: boolean): number {
  if (pushUser) {
    return Math.max(0, chat.history.length - 1);
  }
  return indexOfLastUserMessage(chat.history);
}
