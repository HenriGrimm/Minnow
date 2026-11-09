/**
 * Headless CLI / Scheduler tool approval. Same level and classifier as the
 * desktop gate; there is no one to ask, so an "ask" verdict is a denial the
 * agent can read. Legacy automation flags never override the global mode.
 */

import { getToolSecurityMetaCached } from '../config/tool-security-meta';
import {
  classifyToolCall,
  decidePermission,
  minPermissionLevel,
  type PermissionLevel,
} from '../lib/permissions.mjs';
import type { ToolApprovalContext } from '../tools/permission-gate';
import type { ToolExecutionResult } from '../types';

export interface HeadlessApprovalOptions {
  /** @deprecated Accepted for CLI compatibility; never raises the global mode. */
  noApproval: boolean;
  /** Optional captured caller ceiling; cannot raise the saved global level. */
  permissionLevel?: PermissionLevel;
}

/** Captured callers may narrow the current global level, never widen it. */
export function resolveHeadlessPermissionLevel(options: HeadlessApprovalOptions): PermissionLevel {
  return minPermissionLevel(options.permissionLevel ?? 'full', getToolSecurityMetaCached().permissionLevel);
}

const approvedExternalCalls = new WeakSet<object>();

export function isHeadlessExternalCallApproved(args: object): boolean {
  return approvedExternalCalls.has(args);
}

/**
 * Returns a tool result to short-circuit execution, or null to proceed.
 */
export function maybeBlockHeadlessToolApproval(
  permissionToolId: string,
  args: Record<string, unknown>,
  context: ToolApprovalContext,
  options: HeadlessApprovalOptions,
  displayToolName?: string,
): ToolExecutionResult | null {
  const execName = displayToolName ?? permissionToolId;
  const level = resolveHeadlessPermissionLevel(options);
  const roots = [context.workspaceRoot, ...(context.extraPathRoots ?? [])].filter((r): r is string => Boolean(r?.trim()));
  const action = classifyToolCall(execName, args, { workspaceRoots: roots });
  const verdict = decidePermission(level, action, { clamp: context.turnClamp ?? null });
  if (verdict.decision === 'allow') {
    if (action.external) approvedExternalCalls.add(args);
    return null;
  }
  if (verdict.decision === 'deny') return { content: `Error: ${verdict.reason}` };
  return {
    content:
      `Error: "${action.title}" needs approval, and this non-interactive run cannot ask. ` +
      'Change the global permission mode in Settings → Permissions before running unattended work.',
  };
}
