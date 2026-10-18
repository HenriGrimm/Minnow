/**
 * Top-bar #modelSelect uses a composite value so the same upstream model id
 * can appear on multiple providers without collision.
 */

/** Unit separator — unlikely inside provider ids or LM Studio model ids. */
export const MODEL_SELECT_KEY_SEP = '\u001f';

/**
 * Build the <option> value encoding provider + canonical model id.
 * Both parts are trimmed; empty model id returns empty string (placeholder option).
 */
export function encodeModelSelectKey(providerId: string, modelId: string): string {
  const pid = providerId.trim();
  const mid = modelId.trim();
  if (!mid) return '';
  if (!pid) return mid;
  return `${pid}${MODEL_SELECT_KEY_SEP}${mid}`;
}

/** Parse composite select value; returns null if not a composite key. */
export function decodeModelSelectKey(value: string): { providerId: string; modelId: string } | null {
  const trimmed = value.trim();
  const idx = trimmed.indexOf(MODEL_SELECT_KEY_SEP);
  if (idx <= 0 || idx === trimmed.length - 1) return null;
  const providerId = trimmed.slice(0, idx).trim();
  const modelId = trimmed.slice(idx + 1).trim();
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

/** True when the value uses the composite encoding (not the loading/empty placeholder). */
export function isCompositeModelSelectKey(value: string): boolean {
  return decodeModelSelectKey(value) != null;
}

export interface ModelSelectChatBinding {
  providerId?: string;
  modelId?: string;
}

/**
 * Pick the best `<option>` value for a chat's stored provider/model binding.
 * Prefers the composite key when both provider and model are set.
 */
export function resolveModelSelectValueForChat(
  chat: ModelSelectChatBinding,
  optionValues: readonly string[],
): string {
  const values = optionValues.filter((v) => v.trim() !== '');
  const pid = chat.providerId?.trim();
  const mid = chat.modelId?.trim();
  if (!mid) return '';

  if (pid) {
    const want = encodeModelSelectKey(pid, mid);
    return want;
  }

  const matches = values.filter((v) => decodeModelSelectKey(v)?.modelId === mid || v === mid);
  return matches.length === 1 ? matches[0] : mid;
}

/** Copy provider/model binding from one chat row onto another (desktop composer handoff). */
export function copyChatModelBinding(
  source: ModelSelectChatBinding,
  target: ModelSelectChatBinding,
): void {
  const modelId = source.modelId?.trim();
  if (!modelId) return;
  target.modelId = modelId;
  const providerId = source.providerId?.trim();
  if (providerId) {
    target.providerId = providerId;
  } else {
    delete target.providerId;
  }
}

/** Persist a native or composite `<select>` value onto a chat session. */
export function applyModelSelectValueToChat(
  chat: ModelSelectChatBinding,
  selectValue: string,
): { modelId: string; providerId?: string } {
  const decoded = decodeModelSelectKey(selectValue);
  if (decoded) {
    chat.providerId = decoded.providerId;
    chat.modelId = decoded.modelId;
    return decoded;
  }
  const modelId = selectValue.trim();
  chat.modelId = modelId;
  delete chat.providerId;
  return { modelId };
}

/**
 * Find first modelCache key whose decoded model id matches (any provider).
 * Used when only a canonical model id is known (e.g. API stream) and chat has no provider yet.
 */
export function findFirstSelectKeyForCanonicalModelId(
  cacheKeys: Iterable<string>,
  canonicalModelId: string,
): string | undefined {
  const want = canonicalModelId.trim();
  if (!want) return undefined;
  for (const key of cacheKeys) {
    const decoded = decodeModelSelectKey(key);
    if (decoded && decoded.modelId === want) return key;
    if (!decoded && key === want) return key;
  }
  return undefined;
}
