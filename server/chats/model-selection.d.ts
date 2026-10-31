import type { ModelOptions, ModelSelection } from './contracts.js';
export const AGENT_POOL_PROVIDER_ID: 'minnow-router';
export const AGENT_LIBRARY_PROVIDER_ID: 'minnow-library';
export interface AgentModelAdapters {
  listProviders(): Promise<unknown>;
  listModels(providerId: string): Promise<unknown>;
  readCapabilities(providerId: string): Promise<any>;
  listPools(): Promise<any>;
  resolvePoolId(id: string, workspacePath?: string): Promise<string>;
  poolAvailability(pool: any, request: Record<string, unknown>): Promise<Record<string, { available: boolean; reason?: string }>>;
  listLibraryModels(): Promise<any>;
  resolveLibraryTarget(id: string): Promise<unknown>;
  listServes(): Promise<any[]>;
  listAgentTypes(): Promise<any>;
  modelAvailability(selection: ModelSelection): Promise<{ available: boolean; kind?: string; reason?: string }>;
}
export interface AgentCatalogContext {
  adapters?: Partial<AgentModelAdapters>;
  signal?: AbortSignal;
  workspacePath?: string;
  request?: Record<string, unknown>;
}
export interface ModelOptionSupport {
  readonly reasoningEffort: readonly string[];
  readonly thinkingMode: readonly string[];
  readonly thinkingBudgetTokens: { readonly supported: boolean; readonly enforcement: 'native' | 'runner' | null };
  readonly sendCapabilities: {
    readonly reasoning: boolean;
    readonly reasoningAllowedOptions: readonly string[];
    readonly reasoningDefault?: string;
  };
}
export interface AgentModelSelectionInput {
  target?: ModelSelection;
  typeConfig?: { enabled?: boolean; providerId?: string; modelId?: string; options?: ModelOptions; reasoningEffort?: string; thinkingMode?: 'inherit' | 'on' | 'off'; thinkingBudgetTokens?: number | null };
  defaultModel?: ModelSelection | null;
  parentSelection?: ModelSelection | null;
}
export interface ResolvedAgentModelSelection {
  selection: ModelSelection;
  source: 'explicit' | 'type' | 'routing' | 'parent';
  exactModel: boolean;
  vision?: boolean;
  availability: { state: 'available' | 'loadable' | 'loading_model'; reason: string };
  sendCapabilities?: ModelOptionSupport['sendCapabilities'];
  pool?: { id: string; revision: number; eligibleEntryIds: string[] };
}
export function createAgentModelAdapters(overrides?: Partial<AgentModelAdapters>): AgentModelAdapters;
export function createAgentCatalogContext(context?: AgentCatalogContext): any;
export function modelOptionSupport(model: any, providerCapabilities?: any, provider?: any): ModelOptionSupport;
export function assertSupportedModelOptions(options: ModelOptions | undefined, support: ModelOptionSupport): ModelOptions;
export function libraryCatalogModels(rows: any[]): any[];
export function inspectAgentModel(selection: ModelSelection, context?: AgentCatalogContext): Promise<any>;
export function inspectAgentPool(selection: ModelSelection, context?: AgentCatalogContext): Promise<any>;
export function resolveAgentModelSelection(input?: AgentModelSelectionInput, context?: AgentCatalogContext): Promise<ResolvedAgentModelSelection>;
