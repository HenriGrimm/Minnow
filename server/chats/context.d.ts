import type { ChatRepository, ChatShell, ProfileRecord, ExecutionRecord, ExecutionFence } from './repository.js';
import type { ChatCaller, ChatProjectRegistry, ChatProjectScope } from './caller.js';
import type { ChatPolicyInput, ChatPolicySnapshot } from './policy.js';
export interface ChatProject { registry: ChatProjectRegistry; projectId: string; scope: ChatProjectScope }
export interface ChatTargetContext {
  chat: ChatShell; scope: ChatProjectScope; policy: ChatPolicySnapshot; currentPolicy: ChatPolicySnapshot;
  profile: ProfileRecord | null; registry: ChatProjectRegistry; project: ChatProject;
}
export interface ChatContext {
  setWorkspaceEdgesLoader(loader: (project: ChatProject) => Promise<import('./caller.js').DerivedChatWorkspaceEdge[]>): void;
  project(workspacePath?: string): Promise<ChatProject>;
  resolveTarget(chatId: string, options?: { project?: ChatProject; workspacePath?: string }): Promise<ChatTargetContext>;
  humanCaller(chatId: string, options?: { workspacePath?: string; ingress?: 'renderer' | 'device' | 'cli' | 'scheduler' }): Promise<{ caller: ChatCaller; target: ChatTargetContext }>;
  executionCaller(executionId: string): Promise<{ caller: ChatCaller; target: ChatTargetContext; execution: ExecutionRecord; fence: ExecutionFence }>;
}
export function loadChatProjectRegistry(workspacePath: string, options?: { validateRoot?: (value: string) => Promise<unknown>; runGit?: (args: string[], cwd: string) => Promise<any> }): Promise<ChatProject>;
export function createChatContext(options: {
  repository: ChatRepository;
  resolvePolicyInput: (chat: ChatShell, scope: ChatProjectScope, registry: ChatProjectRegistry) => Promise<ChatPolicyInput>;
  validateRoot?: (value: string) => Promise<unknown>;
  runGit?: (args: string[], cwd: string) => Promise<any>;
}): ChatContext;
