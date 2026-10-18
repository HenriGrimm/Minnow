import { resolveSubAgentBinding } from './sub-agent-binding.mjs';
import type { Chat } from '../types';

export interface SubAgentTypeBindingInput {
  providerId: string;
  modelId: string;
}

export interface SubAgentBindingDefaults {
  providerId: string;
  modelId: string;
}

export function resolveSubAgentModelBinding(
  typeConfig: SubAgentTypeBindingInput,
  parentChat: Chat | undefined,
  globalDefaults?: SubAgentBindingDefaults,
): { providerId: string; modelId: string } {
  const binding = resolveSubAgentBinding(typeConfig, parentChat, globalDefaults);
  return { providerId: binding.providerId, modelId: binding.modelId };
}
