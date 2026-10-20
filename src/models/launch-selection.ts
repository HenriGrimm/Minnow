import { decodeModelSelectKey, encodeModelSelectKey } from '../lib/model-select-key';
import { loadDefaultModelValue, modelSelectionLabel, readDefaultModelBinding } from './selection';
import type { ReasoningEffortOption } from '../types';

/** An empty value follows the remembered composer choice until dispatch starts. */
export async function captureLaunchModel(value = ''): Promise<{ providerId?: string; modelId: string }> {
  if (!value) await loadDefaultModelValue();
  const binding = value ? decodeModelSelectKey(value) ?? { modelId: value } : readDefaultModelBinding();
  if (!binding.modelId) throw new Error('Choose a chat model before starting work.');
  return { ...binding };
}

const issueModels = new Map<string, string>();
const issueReasoning = new Map<string, ReasoningEffortOption>();
export function issueLaunchReasoning(key: string): ReasoningEffortOption | undefined { return issueReasoning.get(key); }
export function setIssueLaunchReasoning(key: string, value?: ReasoningEffortOption): void { if (value) issueReasoning.set(key, value); else issueReasoning.delete(key); }
export function issueLaunchModel(key: string): string { return issueModels.get(key) || ''; }
export function setIssueLaunchModel(key: string, value: string): void { if (value !== issueLaunchModel(key)) issueReasoning.delete(key); if (value) issueModels.set(key, value); else issueModels.delete(key); }
export function clearIssueLaunchModel(key: string): void { issueModels.delete(key); issueReasoning.delete(key); }

export function launchModelLabel(value: string): string {
  const remembered = readDefaultModelBinding();
  const selected = value || encodeModelSelectKey(remembered.providerId || '', remembered.modelId);
  return modelSelectionLabel(selected) || 'Choose model';
}
