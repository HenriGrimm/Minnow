import type { ChatCaller, ChatProjectScope } from './caller';
import type { ChatProject, ChatTargetContext } from './context';
import type { ChatWorkspaceBinding, ChatWorkspaceRepository, ChatWorkspaceStrategy } from './workspace-repository';
export interface ChatWorkspaceChoice { kind: ChatWorkspaceStrategy; workspaceId?: string }
export function normalizeChatWorkspaceStrategy(strategy?: ChatWorkspaceStrategy | ChatWorkspaceChoice, workspaceId?: string): ChatWorkspaceChoice;
export interface ChatCheckoutProbe { canonicalPath: string; commonDir: string | null; topLevel: string | null; head: string | null; branch: string | null; dirty: boolean }
export interface ChatWorkspaceAdapters {
  loadProject(cwd: string): Promise<ChatProject>;
  probeCheckout(cwd: string, signal?: AbortSignal): Promise<ChatCheckoutProbe>;
  slotPath(slotId: string, source: string): string;
  exists(full: string): Promise<boolean>;
  create(input: { slotId: string; source: string; branch: string; baseSha: string; signal?: AbortSignal }): Promise<any>;
  prepareDependencies(source: string, target: string, options?: { signal?: AbortSignal }): Promise<any>;
}
export interface ChatWorkspaceResult {
  binding: ChatWorkspaceBinding; project: ChatProject; scope: ChatProjectScope; derivedFromWorkspaceId?: string;
  chatPatch: { workspacePath: string; worktreeRoot: string; gitBranch: string; chatWorktreeManaged: boolean; workspaceStrategy: ChatWorkspaceStrategy; workspaceAllocationId: string };
}
export interface VerifiedChatWorkspaceEdge {
  allocationId: string; childChatId: string; projectId: string; sourceWorkspaceId: string; targetWorkspaceId: string;
  sourceCanonicalPath: string; targetCanonicalPath: string;
}
export interface ChatWorkspaceResolver {
  resolve(input: { allocationId: string; childChatId: string; strategy?: ChatWorkspaceStrategy | ChatWorkspaceChoice; workspaceId?: string;
    caller: ChatCaller; sourceTarget: ChatTargetContext; signal?: AbortSignal; retrySetup?: boolean }): Promise<ChatWorkspaceResult>;
  listVerifiedEdges(project: ChatProject, options?: { signal?: AbortSignal }): Promise<VerifiedChatWorkspaceEdge[]>;
}
export function createChatWorkspaceAdapters(overrides?: Partial<ChatWorkspaceAdapters>): ChatWorkspaceAdapters;
export function createChatWorkspaceResolver(options?: {
  workspaceRepository?: ChatWorkspaceRepository; adapters?: Partial<ChatWorkspaceAdapters>; ownerId?: string;
  /** Must recheck the caller's active execution/lease and current source policy. */
  refreshSourceTarget?: (caller: ChatCaller, sourceChatId: string) => Promise<ChatTargetContext>;
  feature?: () => { creationEnabled: boolean };
}): ChatWorkspaceResolver;
