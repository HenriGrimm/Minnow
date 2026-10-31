import type { ChatCommand } from './contracts.js';
import type { ChatShell, ExecutionRecord, ExecutionFence } from './repository.js';
import type { ChatTargetContext } from './context.js';
import type { ChatProjectScope } from './caller.js';
import type { ChatPolicyInput, ChatPolicySnapshot } from './policy.js';
import type { AgentModelAdapters } from './model-selection.js';
import type { RunnerDeps } from '../runner/adapters.js';
import type { RunTurnOptions, TurnModel, TurnToolDefinition } from '../runner/run-turn.js';

export type ChatContextBodies = Partial<Record<'brain-notes' | 'code-map' | 'context-documents', string>>;
export interface ChatPreparationAdapters {
  loadComposer(): Promise<any>;
  readSettings(): Promise<{ meta: any; tools: any; rules: any; legacySystemPrompt?: string }>;
  listTools(): Promise<TurnToolDefinition[]>;
  loadWorkAgents(): Promise<any>;
  loadSubAgentTypes(): Promise<any>;
  isServerToolAvailable(name: string): Promise<boolean>;
  resolveModelContextLimit(model: TurnModel): Promise<number | null>;
  bindLibraryModel(model: { providerId: string; id: string }, options?: { signal?: AbortSignal }): Promise<{ providerId: string; id: string }>;
  loadPromptSources(agents: any[]): Promise<{ builtinRaw: Record<string, string>; userRaw?: Record<string, string> }>;
  loadTypePrompt(typeId: string, type: any, profile: 'full' | 'lite'): Promise<string>;
  loadCustomPrompt(id: string): Promise<any>;
  readTranscript(chatId: string): Promise<any>;
  readProfile(reference: import('./contracts.js').AgentProfileReference): Promise<import('./repository.js').ProfileRecord | null>;
  retrieveMemory(input: any): Promise<string>;
  retrieveCodeMap(input: any): Promise<string>;
}
export interface PreparedChatExecution {
  systemPrompt: string;
  cliTurnContext?: string;
  tools: TurnToolDefinition[];
  model: TurnModel;
  cwd: string;
  policy: ChatPolicySnapshot;
  contextBodies: ChatContextBodies;
  sendCapabilities?: import('./model-selection.js').ModelOptionSupport['sendCapabilities'];
  providerCapabilities?: any;
  selectedModelSelection: import('./contracts.js').ModelSelection;
  hostToolNames: string[];
  toolContext: {
    modeId: ChatPolicySnapshot['modeId']; workspaceRoot: string; filesystemAccess: 'workspace' | 'full';
    shellSandboxMode: 'off' | 'prefer' | 'require'; workAgentId: string | null;
  };
  deps?: RunnerDeps;
  limits?: RunTurnOptions['limits'];
}
export interface ChatPreparationInput {
  command: ChatCommand;
  execution: ExecutionRecord;
  fence: ExecutionFence;
  signal?: AbortSignal;
}
export function loadChatPreparationComposer(): Promise<any>;
export function createChatPreparationAdapters(overrides?: Partial<ChatPreparationAdapters>): ChatPreparationAdapters;
export function resolveChatPolicyInput(chat: ChatShell, scope: ChatProjectScope, options?: {
  workspaceIds?: readonly string[]; adapters?: Partial<ChatPreparationAdapters>;
}): Promise<ChatPolicyInput>;
export function captureChatProfile(chat: ChatShell, scope: ChatProjectScope, options?: {
  workspaceIds?: readonly string[]; adapters?: Partial<ChatPreparationAdapters>; modelSelection?: import('./contracts.js').ModelSelection; exactModel?: boolean;
}): Promise<{ policy: ChatPolicySnapshot; exactModel: boolean; modelSelection?: import('./contracts.js').ModelSelection; typeId?: string; typeConfig?: any; prompt: Record<string, any> }>;
export function prepareChatExecution(input: ChatPreparationInput, options: {
  resolveTarget(chatId: string): Promise<ChatTargetContext>;
  adapters?: Partial<ChatPreparationAdapters>;
  modelAdapters?: Partial<AgentModelAdapters>;
  createRunnerDeps?(input: PreparedChatExecution & ChatPreparationInput): Promise<RunnerDeps> | RunnerDeps;
}): Promise<PreparedChatExecution>;
