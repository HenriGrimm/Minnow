import { decodeModelSelectKey, encodeModelSelectKey } from '../lib/model-select-key';
import { loadDefaultModelValue, modelSelectionLabel, readDefaultModelBinding } from './selection';

/** An empty value follows the remembered composer choice until dispatch starts. */
export async function captureLaunchModel(value = ''): Promise<{ providerId?: string; modelId: string }> {
  if (!value) await loadDefaultModelValue();
  const binding = value ? decodeModelSelectKey(value) ?? { modelId: value } : readDefaultModelBinding();
  if (!binding.modelId) throw new Error('Choose a chat model before starting work.');
  return { ...binding };
}

const issueModels = new Map<string, string>();
export function issueLaunchModel(key: string): string { return issueModels.get(key) || ''; }
export function setIssueLaunchModel(key: string, value: string): void { if (value) issueModels.set(key, value); else issueModels.delete(key); }
export function clearIssueLaunchModel(key: string): void { issueModels.delete(key); }

export function launchModelLabel(value: string): string {
  const remembered = readDefaultModelBinding();
  const selected = value || encodeModelSelectKey(remembered.providerId || '', remembered.modelId);
  return modelSelectionLabel(selected) || 'Choose model';
}
