/**
 * Pure effective binding helpers for model routing display (no DOM / session fetch).
 */

import { resolveSubAgentModelBinding } from '../agents/resolve-sub-agent-binding';
import { resolveUiDesignerModel } from '../agents/ui-designer/model-resolution';
import type { WorkAgentDefinition } from '../agents/work-agent-types';
import type { Chat } from '../types';

export interface ChatBindingContext {
  providerId: string;
  modelId: string;
}

/** Pure work-agent effective binding (matches resolveWorkAgentBinding, no provider fetch). */
export function computeEffectiveWorkAgentBinding(
  agent: WorkAgentDefinition,
  chat: ChatBindingContext,
  defaults: ChatBindingContext,
): { providerId: string; modelId: string; usesChatDefault: boolean } {
  return { providerId: chat.providerId || defaults.providerId, modelId: chat.modelId || defaults.modelId, usesChatDefault: true };
}

/** Pure title job model resolution (matches schedule.ts resolveTitleGenerationOptions). */
export function computeEffectiveTitleBinding(
  titles: { providerId: string; modelId: string },
  chat: ChatBindingContext,
  scheduled?: ChatBindingContext,
): { providerId: string; modelId: string; usesChatDefault: boolean } {
  const modelId =
    titles.modelId.trim() || scheduled?.modelId?.trim() || chat.modelId.trim();
  const providerId =
    titles.providerId.trim() ||
    scheduled?.providerId?.trim() ||
    chat.providerId?.trim() ||
    '';
  const usesChatDefault = !titles.modelId.trim();
  return { providerId, modelId, usesChatDefault };
}

/** Pure goal evaluator model resolution (matches goal/evaluate.ts). */
export function computeEffectiveGoalEvalBinding(
  goalEval: { providerId: string; modelId: string },
  chat: ChatBindingContext,
): { providerId: string; modelId: string; usesChatDefault: boolean } {
  const modelId = goalEval.modelId.trim() || chat.modelId.trim();
  const providerId = goalEval.providerId.trim() || chat.providerId?.trim() || '';
  const usesChatDefault = !goalEval.modelId.trim();
  return { providerId, modelId, usesChatDefault };
}

/** Pure composer expand binding (matches resolveExpandPromptBinding). */
export function computeEffectivePromptExpanderBinding(
  promptExpander: { providerId: string; modelId: string },
  chat: ChatBindingContext,
): { providerId: string; modelId: string; usesChatDefault: boolean } {
  return computeEffectiveGoalEvalBinding(promptExpander, chat);
}

/** Pure editor AI binding (matches resolveEditorAiBinding when useChatModel is set). */
export function computeEffectiveEditorCompletionBinding(
  editor: {
    useChatModel: boolean;
    providerId: string;
    modelId: string;
  },
  chat: ChatBindingContext,
): { providerId: string; modelId: string; usesChatDefault: boolean } {
  if (editor.useChatModel) {
    return {
      providerId: editor.providerId.trim() || chat.providerId,
      modelId: chat.modelId.trim() || editor.modelId.trim(),
      usesChatDefault: true,
    };
  }
  const modelId = editor.modelId.trim() || chat.modelId.trim();
  const providerId = editor.providerId.trim() || chat.providerId?.trim() || '';
  const usesChatDefault = !editor.modelId.trim();
  return { providerId, modelId, usesChatDefault };
}

export { resolveSubAgentModelBinding, resolveUiDesignerModel };
export type { Chat };
