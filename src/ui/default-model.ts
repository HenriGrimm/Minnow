import {
  applyModelSelectValueToChat,
  decodeModelSelectKey,
  encodeModelSelectKey,
  type ModelSelectChatBinding,
  resolveModelSelectValueForChat,
} from '../lib/model-select-key';

import { getRouterConfigSync } from '../models/routers';
import { isServerStorageMode } from '../config/storage-mode';

export const DEFAULT_MODEL_STORAGE_KEY = 'minnow-default-model-select';
let serverValue: string | undefined;
let selectionRevision = 0;
let pendingSave = Promise.resolve();

/** Refresh the global disk preference before choosing from a new catalog. */
export async function loadDefaultModelValue(): Promise<void> {
  if (!isServerStorageMode()) return;
  const revision = selectionRevision;
  await pendingSave;
  const response = await fetch('/api/config/default-model', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load the default model');
  const saved = await response.json() as { value: string | null };
  if (revision !== selectionRevision) return;
  if (typeof saved.value === 'string') {
    serverValue = saved.value.trim();
    cacheDefaultModelValue(serverValue);
  } else {
    const legacy = readPersistedDefaultModelValue();
    if (legacy) await persistDefaultModelValue(legacy);
  }
}

/** Read the persisted default model select value (composite key or canonical id). */
export function readPersistedDefaultModelValue(): string {
  if (isServerStorageMode() && serverValue !== undefined) return serverValue;
  try {
    return localStorage.getItem(DEFAULT_MODEL_STORAGE_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

/** Persist the default model select value for the next session. */
function cacheDefaultModelValue(value: string): void {
  try {
    const trimmed = value.trim();
    if (trimmed) localStorage.setItem(DEFAULT_MODEL_STORAGE_KEY, trimmed);
    else localStorage.removeItem(DEFAULT_MODEL_STORAGE_KEY);
  } catch {
  }
}

export function persistDefaultModelValue(value: string): Promise<void> {
  const trimmed = value.trim();
  selectionRevision++;
  cacheDefaultModelValue(trimmed);
  if (!isServerStorageMode()) return Promise.resolve();
  serverValue = trimmed;
  const save = pendingSave.then(async () => {
    const response = await fetch('/api/config/default-model', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: trimmed }),
      keepalive: true,
    });
    if (!response.ok) throw new Error('Could not save the default model');
  });
  pendingSave = save.catch(() => {});
  return save;
}

/** Refresh provider/model on a chat that already has a per-chat binding. */
export function syncPerChatModelBindingFromCatalog(chat: ModelSelectChatBinding): void {
  const mid = chat.modelId?.trim();
  if (!mid) return;
  const sel = document.getElementById('modelSelect') as HTMLSelectElement | null;
  const optionValues = sel ? [...sel.options].map((o) => o.value) : [];
  const chatValue = resolveModelSelectValueForChat(chat, optionValues);
  if (chatValue) {
    applyModelSelectValueToChat(chat, chatValue);
  }
}

/** Read canonical model id + optional provider from the default #modelSelect. */
export function readDefaultModelBinding(): { modelId: string; providerId?: string } {
  const routerId = !readPersistedDefaultModelValue() && getRouterConfigSync().defaultRouterId;
  if (routerId) return { providerId: 'minnow-router', modelId: routerId };
  const raw = readPersistedDefaultModelValue() || (document.getElementById('modelSelect') as HTMLSelectElement | null)?.value || '';
  const parsed = decodeModelSelectKey(raw);
  const modelId = (parsed?.modelId ?? raw).trim();
  return { modelId, providerId: parsed?.providerId };
}

/** Resolve the best persisted default against current catalog options. */
export function resolveDefaultModelSelectValue(optionValues: readonly string[]): string {
  const persisted = readPersistedDefaultModelValue();
  if (persisted) return persisted;
  const routerId = getRouterConfigSync().defaultRouterId;
  const routerValue = routerId ? encodeModelSelectKey('minnow-router', routerId) : '';
  if (routerValue && optionValues.includes(routerValue)) return routerValue;
  return '';
}

/** Effective model for a chat turn: chat binding first, then the global default. */
export function resolveEffectiveChatModelBinding(
  chat: ModelSelectChatBinding,
): { modelId: string; providerId?: string; selectValue: string } {
  const sel = document.getElementById('modelSelect') as HTMLSelectElement | null;
  const optionValues = sel ? [...sel.options].map((o) => o.value) : [];

  const chatValue = resolveModelSelectValueForChat(chat, optionValues);
  if (chatValue) {
    const decoded = decodeModelSelectKey(chatValue);
    return {
      modelId: decoded?.modelId ?? chatValue,
      providerId: decoded?.providerId ?? chat.providerId?.trim(),
      selectValue: chatValue,
    };
  }

  const chatMid = chat.modelId?.trim();
  if (chatMid) {
    return {
      modelId: chatMid,
      providerId: chat.providerId?.trim(),
      selectValue: chat.providerId?.trim()
        ? encodeModelSelectKey(chat.providerId, chatMid)
        : chatMid,
    };
  }

  const defaultRaw = readPersistedDefaultModelValue() || sel?.value.trim() || '';
  const decoded = decodeModelSelectKey(defaultRaw);
  const modelId = (decoded?.modelId ?? defaultRaw).trim();
  return {
    modelId,
    providerId: decoded?.providerId,
    selectValue: defaultRaw,
  };
}

/** Apply the global default binding onto a chat (e.g. new chat or ephemeral reuse). */
export function applyDefaultModelToChat(chat: ModelSelectChatBinding): void {
  const routerId = !readPersistedDefaultModelValue() && getRouterConfigSync().defaultRouterId;
  if (routerId) { chat.providerId = 'minnow-router'; chat.modelId = routerId; return; }
  const sel = document.getElementById('modelSelect') as HTMLSelectElement | null;
  const defaultRaw = readPersistedDefaultModelValue() || sel?.value.trim() || '';
  if (!defaultRaw) return;
  applyModelSelectValueToChat(chat, defaultRaw);
}
