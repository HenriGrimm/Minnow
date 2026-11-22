import type { ChatRepository, ChatShell, ProfileRecord, ExecutionRecord, ExecutionFence } from './repository.js';
import type { ChatCaller, ChatProjectRegistry, ChatProjectScope } from './caller.js';
import type { ChatPolicyInput, ChatPolicySnapshot } from './policy.js';
export interface ChatProject { registry: ChatProjectRegistry; projectId: string; scope: ChatProjectScope }
export interface ChatTargetContext {
  chat: ChatShell; scope: ChatProjectScope; policy: ChatPolicySnapshot; currentPolicy: ChatPolicySnapshot;
  profile: ProfileRecord | null; registry: ChatProjectRegistry; project: ChatProject;
  checkoutIdentity?: string;
}
export interface ChatContext {
  setWorkspaceEdgesLoader(loader: (project: ChatProject) => Promise<import('./workspace.js').VerifiedChatWorkspaceEdge[]>): void;
  project(workspacePath?: string): Promise<ChatProject>;
  findMissingWorktree(chatId: string, workspacePath?: string): Promise<ChatShell | null>;
  verifyMirroredSlot(intent: import('./workspace-preparation.js').ChatWorkspaceIntent,
    expected?: import('./workspace-preparation.js').MirrorBinding | null, options?: { ready?: boolean }):
    Promise<{ binding: import('./workspace-preparation.js').MirrorBinding; project: ChatProject; scope: ChatProjectScope }>;
  resolveTarget(chatId: string, options?: { project?: ChatProject; workspacePath?: string; workspaceRecovery?: boolean }): Promise<ChatTargetContext>;
  humanCaller(chatId: string, options?: { workspacePath?: string; ingress?: 'renderer' | 'device' | 'cli' | 'scheduler'; workspaceRecovery?: boolean }): Promise<{ caller: ChatCaller; target: ChatTargetContext }>;
  executionCaller(executionId: string): Promise<{ caller: ChatCaller; target: ChatTargetContext; execution: ExecutionRecord; fence: ExecutionFence }>;
}
export function loadChatProjectRegistry(workspacePath: string, options?: { validateRoot?: (value: string) => Promise<unknown>; runGit?: (args: string[], cwd: string) => Promise<any> }): Promise<ChatProject>;
export function readChatCheckoutIdentity(workspacePath: string): Promise<string>;
export function createChatContext(options: {
  repository: ChatRepository;
  resolvePolicyInput: (chat: ChatShell, scope: ChatProjectScope, registry: ChatProjectRegistry) => Promise<ChatPolicyInput>;
  validateRoot?: (value: string) => Promise<unknown>;
  runGit?: (args: string[], cwd: string) => Promise<any>;
}): ChatContext;
