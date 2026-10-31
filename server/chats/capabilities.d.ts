import type { ModelSelection } from './contracts.js';
import type { AgentCatalogContext } from './model-selection.js';
export interface AgentCapabilitiesInput { search?: string; cursor?: string; limit?: number }
export interface AgentCapabilitiesContext extends AgentCatalogContext {
  inherited?: ModelSelection;
  favorites?: readonly ModelSelection[];
  configuredSelections?: readonly ModelSelection[];
  types?: Record<string, any> | { types: Record<string, any> };
}
export interface AgentCapabilityTarget {
  providerId: string;
  modelId: string;
  providerLabel: string;
  label: string;
  kind: 'model' | 'library' | 'pool';
  revision?: number;
  options: {
    reasoningEffort: string[];
    thinkingMode: string[];
    thinkingBudgetTokens: { supported: boolean; enforcement: string | null };
    memberFiltering?: boolean;
  };
  availability: { state: 'available' | 'unavailable' | 'loadable' | 'loading_model'; reason: string };
}
export function listAgentCapabilities(input?: AgentCapabilitiesInput, context?: AgentCapabilitiesContext): Promise<{
  inherited?: ModelSelection;
  types: { id: string; label: string }[];
  targets: AgentCapabilityTarget[];
  omittedModels: number;
  nextCursor: string | null;
  unavailableProviders: { providerId: string; label: string; reason: string }[];
  omittedProviders: number;
}>;
