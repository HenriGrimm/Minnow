import type { ContextEnforcementPolicy } from '../chat/context-budget';

export interface PackContextStrategy {
  maxInputTokens?: number | null;
  policy?: 'inherit' | ContextEnforcementPolicy;
}

export interface PackAgentEntry {
  key: string;
  label: string;
  description?: string;
  prompts: { full: string };
  providerId?: string | null;
  modelId?: string | null;
  allowedTools?: string[] | null;
  defaultForModes?: string[];
  disabled?: boolean;
  contextStrategy?: PackContextStrategy;
}

export interface AgentPackManifest {
  id: string;
  label: string;
  version: string;
  description?: string;
  minMinnowVersion?: string;
  enabled?: boolean;
  defaults?: {
    providerId?: string | null;
    modelId?: string | null;
    allowedTools?: string[] | null;
  };
  agents: PackAgentEntry[];
}

export interface PackAgentSource {
  packId: string;
  agentKey: string;
  packRoot: string;
  promptPaths: { full: string };
  contextStrategy?: PackContextStrategy;
}

export interface AgentPackListItem {
  id: string;
  label: string;
  version: string;
  description?: string;
  enabled: boolean;
  valid: boolean;
  errors: string[];
  agents: Array<{
    id: string;
    key: string;
    label: string;
    description?: string;
  }>;
  packRoot: string;
}
