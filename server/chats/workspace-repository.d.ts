import type { Database } from 'better-sqlite3';
export type ChatWorkspaceStrategy = 'shared' | 'new_worktree' | 'existing_worktree';
export type ChatWorkspaceSetupState = 'reserved' | 'allocating' | 'ready' | 'failed' | 'cancelled' | 'recovery_required' | 'tombstoned';
export interface ChatWorkspaceReservation {
  allocationId: string; childChatId: string; projectId: string; strategy: ChatWorkspaceStrategy;
  sourceWorkspaceId: string; sourceCanonicalPath: string; sourceCommonDir: string | null;
  targetPath: string; slotId: string | null; branch: string | null; baseSha: string | null; sourceHeadSha: string | null; sourceDirty: boolean;
}
export interface ChatWorkspaceBinding extends ChatWorkspaceReservation {
  version: 1; setupState: ChatWorkspaceSetupState; ownerId: string | null;
  targetCanonicalPath: string | null; targetWorkspaceId: string | null; uncommittedParentEditsExcluded: boolean;
  dependencies: any; error: string | null; cancelledAt: number | null; deletedAt: number | null;
  revision: number; createdAt: number; updatedAt: number;
}
export interface ChatWorkspaceRepository {
  getByAllocation(allocationId: string): ChatWorkspaceBinding | null;
  getByChild(childChatId: string): ChatWorkspaceBinding | null;
  reserve(input: ChatWorkspaceReservation): ChatWorkspaceBinding & { replayed: boolean };
  claim(allocationId: string, options: { expectedRevision: number; ownerId: string; retry?: boolean }): ChatWorkspaceBinding;
  update(allocationId: string, patch: Partial<Pick<ChatWorkspaceBinding, 'setupState' | 'ownerId' | 'targetCanonicalPath' | 'targetWorkspaceId' | 'dependencies' | 'error' | 'cancelledAt' | 'deletedAt'>>, options: { expectedRevision: number; ownerId?: string }): ChatWorkspaceBinding;
  tombstone(childChatId: string): ChatWorkspaceBinding | null;
  list(options?: { projectId?: string; setupState?: ChatWorkspaceSetupState; afterAllocationId?: string; limit?: number }): ChatWorkspaceBinding[];
}
export function initChatWorkspaceSchema(db: Database): void;
export function createChatWorkspaceRepository(options?: { db?: Database; now?: () => number }): ChatWorkspaceRepository;
