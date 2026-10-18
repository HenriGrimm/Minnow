import {
  applyModelSelectValueToChat,
  decodeModelSelectKey,
  encodeModelSelectKey,
  type ModelSelectChatBinding,
  resolveModelSelectValueForChat,
} from '../lib/model-select-key';

import { isServerStorageMode } from '../config/storage-mode';
import { getModelReasoningDefault } from '../config/model-reasoning-defaults';
import type { ReasoningEffortOption } from '../types';

export const DEFAULT_MODEL_STORAGE_KEY = 'minnow-default-model-select';
let serverValue: string | undefined;
let volatileValue = '';
let cacheWriteFailed = false;
let selectionRevision = 0;
let pendingSave = Promise.resolve();
let serverRevision = -1;
const listeners = new Set<() => void>();
let catalogValues: string[] = [];
const catalogLabels = new Map<string, string>();
export function setModelCatalogEntries(entries: readonly { value: string; label: string }[]): void {
  catalogValues = entries.map((entry) => entry.value);
  catalogLabels.clear();
  for (const entry of entries) catalogLabels.set(entry.value, entry.label);
}
export function modelSelectionLabel(value: string): string {
  return catalogLabels.get(value) || decodeModelSelectKey(value)?.modelId || value;
}

export function setModelCatalogValues(values: readonly string[]): void { catalogValues = [...values]; }
export function getModelCatalogValues(): readonly string[] { return catalogValues; }
export function subscribeModelSelection(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function notifySelection(): void { for (const listener of listeners) listener(); }

/** Refresh the global disk preference before choosing from a new catalog. */
export async function loadDefaultModelValue(): Promise<void> {
  if (!isServerStorageMode()) return;
  const revision = selectionRevision;
  await pendingSave;
  const response = await fetch('/api/config/default-model', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load the last selected chat model');
  const saved = await response.json() as { value: string | null; revision?: number };
  if (revision !== selectionRevision || (saved.revision ?? 0) < serverRevision) return;
  serverRevision = saved.revision ?? 0;
  if (typeof saved.value === 'string') {
    serverValue = saved.value.trim();
    cacheDefaultModelValue(serverValue);
    notifySelection();
  } else {
    const legacy = readPersistedDefaultModelValue();
    if (legacy) await persistDefaultModelValue(legacy);
  }
}

/** Read the persisted default model select value (composite key or canonical id). */
export function readPersistedDefaultModelValue(): string {
  if (isServerStorageMode() && serverValue !== undefined) return serverValue;
  try {
    return localStorage.getItem(DEFAULT_MODEL_STORAGE_KEY)?.trim() || (cacheWriteFailed ? volatileValue : '');
  } catch {
    return volatileValue;
  }
}

/** Persist the default model select value for the next session. */
function cacheDefaultModelValue(value: string): void {
  volatileValue = value.trim();
  try {
    const trimmed = value.trim();
    if (trimmed) localStorage.setItem(DEFAULT_MODEL_STORAGE_KEY, trimmed);
    else localStorage.removeItem(DEFAULT_MODEL_STORAGE_KEY);
    cacheWriteFailed = false;
  } catch {
    cacheWriteFailed = true;
  }
}

export function persistDefaultModelValue(value: string): Promise<void> {
  const trimmed = value.trim();
  const revision = ++selectionRevision;
  cacheDefaultModelValue(trimmed);
  if (isServerStorageMode()) serverValue = trimmed;
  notifySelection();
  if (!isServerStorageMode()) return Promise.resolve();
  const save = pendingSave.then(async () => {
    const response = await fetch('/api/config/default-model', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: trimmed }),
      keepalive: true,
    });
    if (!response.ok) throw new Error('Could not remember the chat model');
    const saved = await response.json() as { revision?: number };
    if (revision === selectionRevision) serverRevision = Math.max(serverRevision, saved.revision ?? 0);
  });
  pendingSave = save.catch(() => {});
  return save;
}

/** Refresh provider/model on a chat that already has a per-chat binding. */
export function syncPerChatModelBindingFromCatalog(chat: ModelSelectChatBinding): void {
  const mid = chat.modelId?.trim();
  if (!mid) return;
  const optionValues = catalogValues;
  const chatValue = resolveModelSelectValueForChat(chat, optionValues);
  if (chatValue) {
    applyModelSelectValueToChat(chat, chatValue);
  }
}

/** Read the canonical model id and provider from the remembered preference. */
export function readDefaultModelBinding(): { modelId: string; providerId?: string } {
  const raw = readPersistedDefaultModelValue();
  const parsed = decodeModelSelectKey(raw);
  const modelId = (parsed?.modelId ?? raw).trim();
  return { modelId, providerId: parsed?.providerId };
}

/** Resolve the best persisted default against current catalog options. */
export function resolveDefaultModelSelectValue(optionValues: readonly string[]): string {
  const persisted = readPersistedDefaultModelValue();
  if (persisted) return persisted;
  return '';
}

/** Effective model for a chat turn: chat binding first, then the global default. */
export function resolveEffectiveChatModelBinding(
  chat: ModelSelectChatBinding,
): { modelId: string; providerId?: string; selectValue: string } {
  const optionValues = catalogValues;

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

  const defaultRaw = readPersistedDefaultModelValue();
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
  const defaultRaw = readPersistedDefaultModelValue();
  if (!defaultRaw) return;
  applyModelSelectValueToChat(chat, defaultRaw);
  applyModelReasoningDefaultToChat(chat, defaultRaw);
}

/** Apply the saved per-model level, or return the chat to the model/catalog default. */
export function applyModelReasoningDefaultToChat(
  chat: ModelSelectChatBinding & { reasoningEffort?: ReasoningEffortOption },
  selectValue: string,
): void {
  const saved = getModelReasoningDefault(selectValue);
  if (saved) chat.reasoningEffort = saved;
  else delete chat.reasoningEffort;
}
