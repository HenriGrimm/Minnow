import { showToolApprovalModal } from '../ui/tool-approval-modal';
import type { ToolApprovalDecision, ToolApprovalRequest } from './tool-approval-types';

export type { ToolApprovalDecision, ToolApprovalRequest } from './tool-approval-types';

/** Executor metadata the gate needs for one tool call. */
export interface ToolApprovalContext {
  serverAdmission?: import('./server-admission').ServerToolAdmission;
  executionId?: string;
  chatId?: string;
  toolCallId?: string;
  /** Title of the sub-agent running this call (shown on the approval card). */
  subAgentType?: string;
  workAgentId?: string | null;
  /** Legacy persisted mode id; ignored by the permission system. */
  modeId?: string;
  /** Turn clamp from a skill's `access` front matter (`/ask`, `/plan`). */
  turnClamp?: 'read-only' | 'plans' | null;
  /** Override workspace for path checks (benchmark sandbox, worktree, etc.). */
  workspaceRoot?: string;
  /** Additional allowed roots (board worktrees under ~/.minnow/worktrees). */
  extraPathRoots?: string[];
  /** Benchmark runs proceed without approval prompts. */
  benchmarkAutonomous?: boolean;
  /** Cancels this approval (and dismisses the card if it is showing). */
  signal?: AbortSignal;
}

interface Queued {
  request: ToolApprovalRequest;
  resolve: (decision: ToolApprovalDecision) => void;
  settled: boolean;
}

const CANCEL: ToolApprovalDecision = { kind: 'deny' };
const queue: Queued[] = [];
let draining = false;
const listeners = new Set<() => void>();

/** True while an approval card is open or queued (progress-stall pause). */
export function hasPendingToolApproval(): boolean {
  return draining || queue.length > 0;
}

/** Requests waiting behind the visible card (for the "1 of 3" counter). */
export function pendingToolApprovalCount(): number {
  return queue.length + (draining ? 1 : 0);
}

/** Notified whenever the queue length changes. */
export function onToolApprovalQueueChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) {
    try { fn(); } catch { /* listener errors never block approvals */ }
  }
}

function settle(item: Queued, decision: ToolApprovalDecision): void {
  if (item.settled) return;
  item.settled = true;
  item.resolve(decision);
}

export function enqueueToolApproval(request: ToolApprovalRequest): Promise<ToolApprovalDecision> {
  return new Promise((resolve) => {
    if (request.signal?.aborted) {
      resolve(CANCEL);
      return;
    }
    const item: Queued = { request, resolve, settled: false };
    const onAbort = (): void => {
      const idx = queue.indexOf(item);
      if (idx >= 0) {
        queue.splice(idx, 1);
        notify();
      }
      settle(item, CANCEL);
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    queue.push(item);
    notify();
    void drainQueue();
  });
}

/**
 * Settle every queued request whose grant key matches — used after "Allow for
 * this chat" so parallel sub-agents asking the same thing don't each prompt.
 */
export function settleQueuedApprovalsForGrant(grantKey: string, chatId?: string): void {
  for (let i = queue.length - 1; i >= 0; i--) {
    const item = queue[i]!;
    if (item.request.action?.grant?.key !== grantKey || item.request.action.risk === 'high') continue;
    if (chatId && item.request.chatId && item.request.chatId !== chatId) continue;
    queue.splice(i, 1);
    settle(item, { kind: 'allow-once' });
  }
  notify();
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  const next = queue.shift();
  if (!next) return;
  draining = true;
  notify();
  try {
    if (next.settled || next.request.signal?.aborted) {
      settle(next, CANCEL);
      return;
    }
    const decision = await showToolApprovalModal(next.request);
    settle(next, decision);
  } catch {
    settle(next, CANCEL);
  } finally {
    draining = false;
    notify();
    if (queue.length > 0) {
      void drainQueue();
    }
  }
}

/** Drop queued entries so tests do not leak across cases. */
export function resetApprovalQueueForTests(): void {
  queue.length = 0;
  draining = false;
  listeners.clear();
}
