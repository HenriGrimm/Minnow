import type { ClassifiedAction, PermissionLevel } from '../lib/permissions.mjs';

/** Workspace context shown in the approval card. */
export type ToolApprovalWorkspace =
  | { label: string; path: string }
  | { hint: string };

/** Payload passed from the permission gate through the queue to the approval card. */
export interface ToolApprovalRequest {
  /** Resolved tool id (same as the catalog / API function name). */
  toolName: string;
  /** Human headline ("Run a command", "Edit src/a.ts"). */
  title: string;
  /** The thing itself: command, paths, URL, or a short argument summary. */
  description?: string;
  argsJson: string;
  workspace?: ToolApprovalWorkspace;
  /** Shared classification (kind, risk, reasons, chat grant). */
  action?: ClassifiedAction;
  /** System permission level at the time of the request. */
  level?: PermissionLevel;
  /** Title of the sub-agent asking, when not the main agent. */
  agentLabel?: string;
  /** Chat whose grants an "Allow for this chat" answer extends. */
  chatId?: string;
  signal?: AbortSignal;
}

/** What the user picked on the approval card. */
export type ToolApprovalDecision =
  | { kind: 'allow-once' }
  | { kind: 'allow-chat' }
  | { kind: 'deny'; feedback?: string };
