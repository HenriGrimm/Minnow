import { showToolApprovalModal } from '../ui/tool-approval-modal';
import type { ToolApprovalModalResult } from '../ui/tool-approval-modal';
import type { ToolApprovalRequest } from './tool-approval-types';

export type { ToolApprovalRequest } from './tool-approval-types';

export type ToolApprovalDecision = ToolApprovalModalResult;

/** Optional executor metadata (sub-agent label for the modal). */
export interface ToolApprovalContext {
  serverAdmission?: import('./server-admission').ServerToolAdmission;
  executionId?: string;
  chatId?: string;
  toolCallId?: string;
  subAgentType?: string;
  workAgentId?: string | null;
  /** Active composer mode (General always prompts before tool execution). */
  modeId?: string;
  /** Override workspace for path-outside checks (benchmark sandbox, worktree, etc.). */
  workspaceRoot?: string;
  /** Additional allowed roots (board worktrees under ~/.minnow/worktrees). */
  extraPathRoots?: string[];
  /** Benchmark runs proceed without approval or path-ack modals. */
  benchmarkAutonomous?: boolean;
  /** Cancels this approval (and dismisses the strip if it is showing). */
  signal?: AbortSignal;
}

interface Queued {
  request: ToolApprovalRequest;
  resolve: (decision: ToolApprovalDecision) => void;
  settled: boolean;
}

const queue: Queued[] = [];
let draining = false;

/** True while a tool approval modal is open or queued (progress-stall pause). */
export function hasPendingToolApproval(): boolean {
  return draining || queue.length > 0;
}

function settle(item: Queued, decision: ToolApprovalDecision): void {
  if (item.settled) return;
  item.settled = true;
  item.resolve(decision);
}

export function enqueueToolApproval(request: ToolApprovalRequest): Promise<ToolApprovalDecision> {
  return new Promise((resolve) => {
    if (request.signal?.aborted) {
      resolve('cancel');
      return;
    }
    const item: Queued = { request, resolve, settled: false };
    const onAbort = (): void => {
      const idx = queue.indexOf(item);
      if (idx >= 0) {
        queue.splice(idx, 1);
      }
      settle(item, 'cancel');
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    queue.push(item);
    void drainQueue();
  });
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  const next = queue.shift();
  if (!next) return;
  draining = true;
  try {
    if (next.settled || next.request.signal?.aborted) {
      settle(next, 'cancel');
      return;
    }
    const decision = await showToolApprovalModal(next.request);
    settle(next, decision);
  } catch {
    settle(next, 'cancel');
  } finally {
    draining = false;
    if (queue.length > 0) {
      void drainQueue();
    }
  }
}

/** Drop queued entries so tests do not leak across cases. */
export function resetApprovalQueueForTests(): void {
  queue.length = 0;
  draining = false;
}
