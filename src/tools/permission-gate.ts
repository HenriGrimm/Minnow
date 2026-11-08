/**
 * Renderer permission gate: every tool call the agent makes passes through
 * {@link maybeBlockToolForUserApproval} before it runs.
 *
 * One system-wide level (Manual / Auto / Full access) decides, through the
 * shared classifier in `src/lib/permissions.mjs`. There are no per-tool
 * permissions: a tool is either available (not disabled in Settings → Tools)
 * or not, and the level decides whether an available call asks first.
 */

import { getWorkspaceLabel, getWorkspacePath } from '../state/workspace';
import { findChatById, scheduleSaveSessions } from '../state/sessions';
import {
  getToolSecurityMetaCached,
  loadToolSecurityMeta,
  saveToolSecurityMeta,
} from '../config/tool-security-meta';
import { getToolPermissionForId, loadToolConfig } from './config';
import { getCachedRegisteredWorktreePaths } from '../lib/worktree-allowlist-client.ts';
import type { ToolExecutionResult } from '../types';
import {
  enqueueToolApproval,
  settleQueuedApprovalsForGrant,
  type ToolApprovalContext,
} from './approval-queue';
import type { ToolApprovalRequest } from './tool-approval-types';
import { applyDestructiveConfirmationAfterUserApproval } from './destructive-tool-confirm';
import { consumeServerToolAdmission } from './server-admission';
import { resolveToolHint } from './tool-hint-resolver';
import {
  ensureShellSandboxCaches,
  fetchSandboxStatus,
  resolveShellSandboxModeForChat,
  SHELL_SANDBOX_TOOL_IDS,
} from './shell-sandbox-client';
import {
  classifyToolCall,
  decidePermission,
  type ClassifiedAction,
  type PermissionLevel,
} from '../lib/permissions.mjs';

export type { ToolApprovalContext };

// ── Hooks ────────────────────────────────────────────────────────────────────

export { setToolHintResolver } from './tool-hint-resolver';

/**
 * Calls the gate allowed to leave the workspace (auto-allowed or approved).
 * The server tool request carries this so the call can resolve outside paths
 * once, without widening filesystem reach for anything else.
 */
const approvedExternalCalls = new WeakSet<object>();

export function isExternalCallApproved(args: object): boolean {
  return approvedExternalCalls.has(args);
}

// ── AFK ──────────────────────────────────────────────────────────────────────

export function blockAfkInteractionAttempt(
  _context: ToolApprovalContext,
  _kind: 'question' | 'approval' | 'confirmation' | 'mode_switch' | 'other',
  _reason: string,
): ToolExecutionResult | null {
  return null;
}

// ── Grants ───────────────────────────────────────────────────────────────────

/** "Allow for this chat" grants live on the chat record and die with it. */
export function getChatPermissionGrants(chatId: string | undefined): string[] {
  if (!chatId) return [];
  const chat = findChatById(chatId);
  return Array.isArray(chat?.permissionGrants) ? chat!.permissionGrants : [];
}

export function addChatPermissionGrant(chatId: string | undefined, key: string): void {
  if (!chatId || !key) return;
  const chat = findChatById(chatId);
  if (!chat) return;
  const grants = new Set(chat.permissionGrants ?? []);
  if (grants.has(key)) return;
  grants.add(key);
  chat.permissionGrants = [...grants];
  scheduleSaveSessions();
}

export function clearChatPermissionGrants(chatId: string): void {
  const chat = findChatById(chatId);
  if (!chat?.permissionGrants?.length) return;
  chat.permissionGrants = [];
  scheduleSaveSessions();
}

// ── Classification ───────────────────────────────────────────────────────────

function workspaceRootsFor(context: ToolApprovalContext): string[] {
  const root = context.workspaceRoot?.trim() || getWorkspacePath();
  return [root, ...(context.extraPathRoots ?? []), ...getCachedRegisteredWorktreePaths()]
    .map((r) => r?.trim())
    .filter((r): r is string => Boolean(r));
}

/** Classify one call with the renderer's workspace view (exported for UI previews and tests). */
export function classifyForGate(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolApprovalContext,
): ClassifiedAction {
  return classifyToolCall(toolName, args, {
    workspaceRoots: workspaceRootsFor(context),
    toolHint: resolveToolHint(toolName),
  });
}

/** Message returned to the model when the user (or a clamp) says no. */
function deniedResult(action: ClassifiedAction, feedback?: string): ToolExecutionResult {
  const note = feedback?.trim();
  return {
    content: note
      ? `Error: The user denied "${action.title}" and said: ${note}`
      : `Error: The user denied "${action.title}". Do not retry or work around it; ask the user how they want to proceed.`,
  };
}

// ── Gate ─────────────────────────────────────────────────────────────────────

/**
 * Pre-execution gate. Returns null to proceed, or the tool result to return
 * instead (disabled tool, denial, clamp).
 */
export async function maybeBlockToolForUserApproval(
  permissionToolId: string,
  args: Record<string, unknown>,
  context: ToolApprovalContext,
  displayToolName?: string,
): Promise<ToolExecutionResult | null> {
  const execName = displayToolName ?? permissionToolId;

  if (getToolPermissionForId(loadToolConfig(), permissionToolId) === 'off') {
    return { content: `Error: tool "${execName}" is turned off in Settings → Tools.` };
  }

  await loadToolSecurityMeta().catch(() => undefined);
  const level: PermissionLevel = context.benchmarkAutonomous ? 'full' : getToolSecurityMetaCached().permissionLevel;
  const action = classifyForGate(execName, args, context);
  const grants = getChatPermissionGrants(context.chatId);
  const verdict = decidePermission(level, action, { grants, clamp: context.turnClamp ?? null });

  if (verdict.decision === 'deny') {
    return { content: `Error: ${verdict.reason}` };
  }

  let approved = verdict.decision === 'allow';
  if (!approved && consumeServerToolAdmission(context.serverAdmission, execName, args, context)) {
    // The server host channel already showed this exact call to the user.
    approved = true;
  }

  if (!approved) {
    if (typeof document === 'undefined') {
      return { content: `Error: "${action.title}" needs approval, and no one is here to approve it.` };
    }
    const workspaceRoot = context.workspaceRoot?.trim() || getWorkspacePath();
    const request: ToolApprovalRequest = {
      toolName: execName,
      title: action.title,
      description: action.detail,
      argsJson: JSON.stringify(args, null, 2),
      workspace: workspaceRoot
        ? { label: getWorkspaceLabel() || workspaceRoot, path: workspaceRoot }
        : { hint: 'No project open' },
      action,
      level,
      agentLabel: context.subAgentType,
      chatId: context.chatId,
      signal: context.signal,
    };
    const decision = await enqueueToolApproval(request);
    if (decision.kind === 'deny') {
      return deniedResult(action, decision.feedback);
    }
    if (decision.kind === 'allow-chat' && action.grant && action.risk !== 'high') {
      addChatPermissionGrant(context.chatId, action.grant.key);
      settleQueuedApprovalsForGrant(action.grant.key, context.chatId);
    }
    applyDestructiveConfirmationAfterUserApproval(permissionToolId, args);
  } else if (level === 'full' || verdict.reason === 'Allowed for this chat') {
    applyDestructiveConfirmationAfterUserApproval(permissionToolId, args);
  }

  if (action.external) approvedExternalCalls.add(args);

  if (SHELL_SANDBOX_TOOL_IDS.has(permissionToolId)) {
    const sandboxGate = await maybeEscalateShellSandbox(permissionToolId, args, context, execName, level);
    if (sandboxGate) return sandboxGate;
  }

  return null;
}

async function maybeEscalateShellSandbox(
  permissionToolId: string,
  args: Record<string, unknown>,
  context: ToolApprovalContext,
  execName: string,
  level: PermissionLevel,
): Promise<ToolExecutionResult | null> {
  await ensureShellSandboxCaches().catch(() => undefined);
  const mode = resolveShellSandboxModeForChat(context.chatId);
  if (mode === 'off') return null;

  const status = await fetchSandboxStatus();
  if (status?.available === true) return null;

  const detail =
    status?.detail?.trim() ||
    status?.reason?.trim() ||
    'Agent shell sandbox is not available on this platform';

  if (mode === 'require') {
    return {
      content:
        `Error: Agent shell sandbox is required but unavailable. ${detail}. ` +
        'Install/enable the platform sandbox, or change the shell sandbox setting.',
    };
  }

  if (level === 'full' || getToolSecurityMetaCached().allowUnsandboxedShell || args.allow_unsandboxed === true) {
    args.allow_unsandboxed = true;
    return null;
  }

  if (typeof document === 'undefined') {
    return {
      content:
        `Error: Agent shell sandbox unavailable (${detail}). ` +
        'Cannot prompt for unsandboxed approval in this context.',
    };
  }

  const workspaceRoot = context.workspaceRoot?.trim() || getWorkspacePath();
  const action = classifyForGate(execName, args, context);
  const decision = await enqueueToolApproval({
    toolName: execName,
    title: 'Run without the sandbox?',
    description: `${action.detail}\n\nThe shell sandbox is unavailable (${detail}).`,
    argsJson: JSON.stringify(args, null, 2),
    workspace: workspaceRoot
      ? { label: getWorkspaceLabel() || workspaceRoot, path: workspaceRoot }
      : { hint: 'No project open' },
    action: { ...action, grant: { key: 'shell:unsandboxed', label: 'unsandboxed commands' }, reasons: ['The shell sandbox is unavailable'] },
    level,
    agentLabel: context.subAgentType,
    chatId: context.chatId,
    signal: context.signal,
  });

  if (decision.kind === 'deny') {
    return { content: 'Error: User denied unsandboxed shell execution' };
  }
  if (decision.kind === 'allow-chat') {
    await saveToolSecurityMeta({ allowUnsandboxedShell: true }).catch(() => undefined);
  }
  args.allow_unsandboxed = true;
  return null;
}
