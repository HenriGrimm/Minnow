import type { Chat, ChatCompletionChunk } from '../types';
import { decodeModelSelectKey } from '../lib/model-select-key';

/** Missing/initial usage must not erase the last measured native window. */
export function recordNativeContext(
  chat: Chat,
  context: NonNullable<ChatCompletionChunk['minnow_cli']>['context'],
  providerId: string,
  modelId: string,
): boolean {
  if (typeof context?.used !== 'number' || !Number.isFinite(context.used) || context.used <= 0) return false;
  chat.lastNativeContext = {
    providerId, modelId, used: context.used, historyLength: chat.history.length,
    ...(typeof context.limit === 'number' && Number.isFinite(context.limit) && context.limit > 0 ? { limit: context.limit } : {}),
  };
  return true;
}

export function resolveNativeContext(chat: Chat, modelId: string): Chat['lastNativeContext'] {
  const context = chat.lastNativeContext;
  const binding = decodeModelSelectKey(modelId);
  if (!context || context.providerId !== (binding?.providerId ?? chat.providerId)
    || context.modelId !== (binding?.modelId ?? modelId)
    || chat.history.length < context.historyLength) return undefined;
  return context;
}
