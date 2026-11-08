/**
 * Headless CLI / Scheduler tool approval. Same level and classifier as the
 * desktop gate; there is no one to ask, so an "ask" verdict is a denial the
 * agent can read. `--no-approval` (with the env opt-in) runs as Full access.
 */

import { getToolSecurityMetaCached } from '../config/tool-security-meta';
import {
  classifyToolCall,
  decidePermission,
  type PermissionLevel,
} from '../lib/permissions.mjs';
import { getToolPermissionForId, loadToolConfig } from '../tools/config';
import type { ToolApprovalContext } from '../tools/permission-gate';
import type { ToolExecutionResult } from '../types';

/** Env var required with --no-approval (documented in CLI --help). */
export const UNSAFE_AUTOMATION_ENV = 'MINNOW_I_UNDERSTAND_UNSAFE_AUTOMATION';

export interface HeadlessApprovalOptions {
  /** Run as Full access (requires {@link UNSAFE_AUTOMATION_ENV}=1). */
  noApproval: boolean;
  /** Override the saved level (tests, Scheduler jobs with their own level). */
  permissionLevel?: PermissionLevel;
}

/** Level a headless run uses: --no-approval → Full, else the saved system level. */
export function resolveHeadlessPermissionLevel(options: HeadlessApprovalOptions): PermissionLevel {
  if (options.noApproval && process.env[UNSAFE_AUTOMATION_ENV] === '1') return 'full';
  return options.permissionLevel ?? getToolSecurityMetaCached().permissionLevel;
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
  if (getToolPermissionForId(loadToolConfig(), permissionToolId) === 'off') {
    return { content: `Error: tool "${execName}" is turned off in Settings → Tools.` };
  }
  if (options.noApproval && process.env[UNSAFE_AUTOMATION_ENV] !== '1') {
    return { content: `Error: --no-approval requires ${UNSAFE_AUTOMATION_ENV}=1 in the environment.` };
  }

  const level = resolveHeadlessPermissionLevel(options);
  const roots = [context.workspaceRoot, ...(context.extraPathRoots ?? [])].filter((r): r is string => Boolean(r?.trim()));
  const action = classifyToolCall(execName, args, { workspaceRoots: roots });
  const verdict = decidePermission(level, action, { clamp: context.turnClamp ?? null });
  if (verdict.decision === 'allow') return null;
  if (verdict.decision === 'deny') return { content: `Error: ${verdict.reason}` };
  return {
    content:
      `Error: "${action.title}" needs approval, and this non-interactive run cannot ask. ` +
      'Raise the permission level in Settings → Permissions, or pass --no-approval with explicit risk acceptance.',
  };
}
