import type { ChatRepository, ChatShell, ExecutionRecord, ExecutionFence } from './repository.js';
import type { ChatContext, ChatTargetContext } from './context.js';
import type { ChatCommand } from './contracts.js';

export interface CheckoutBinding {
  path: string; checkoutIdentity: string; commonIdentity: string; gitIdentity: string; branch: string; head: string;
}
export interface ChatWorkspaceIntent {
  version: 1; kind: 'automatic'; id: string; chatId: string; projectId: string;
  source: CheckoutBinding; sourceWorkspaceId: string; slotPath: string; title: string;
}
export interface ChatWorkspaceState {
  intent: ChatWorkspaceIntent; status: 'pending' | 'preparing' | 'ready' | 'failed' | 'cancelled' | 'local';
  binding: CheckoutBinding | null; error?: string | null;
}
export interface WorkspacePreparationInput {
  command: ChatCommand; execution: ExecutionRecord; fence: ExecutionFence; signal?: AbortSignal;
}
export function rebindChatWorkspacePolicy(policy: import('./policy.js').ChatPolicyInput,
  binding: { sourceWorkspaceId: string; workspaceId: string }): import('./policy.js').ChatPolicySnapshot;
export function createChatWorkspacePreparation(options: {
  repository: ChatRepository; context: Pick<ChatContext, 'project' | 'resolveTarget'>;
  enableWorktree?: (input: { chatId: string; title: string; signal?: AbortSignal;
    onCheckout: (result: { path: string; branch: string }) => Promise<void> }) => Promise<{ ok: boolean; path?: string; branch?: string; error?: string }>;
  onChange?: (chatId: string) => unknown; id?: () => string;
}): {
  capture(target: ChatTargetContext, choice?: { kind: 'automatic' | 'local' }): Promise<ChatWorkspaceIntent | null>;
  /** Call inside the same repository.atomic transaction as admitCommand. */
  admit(chatId: string, intent: ChatWorkspaceIntent | null): void;
  prepare(input: WorkspacePreparationInput): Promise<{ execution: ExecutionRecord; target: ChatTargetContext }>;
  read(chatId: string): ChatWorkspaceState | null;
  /** Authenticated human-only action. Never deletes the retained checkout. */
  chooseLocal(input: { chatId: string; expectedIntentId: string }): ChatShell;
  /** Authenticated human Retry; prepares dependencies but never replays inference. */
  retry(input: { chatId: string; expectedIntentId: string; signal?: AbortSignal }): Promise<ChatShell>;
  stopRetry(chatId: string, executionId?: string): boolean;
  applyChoice(caller: import('./caller.js').ChatCaller, input: { chatId: string; action: 'retry' | 'local';
    expectedIntentId: string; clientRequestId?: string }): Promise<{ chat: ChatShell }>;
};
