import { executeServerTool } from '../runtime/tools-middleware.js';
import { validateAllowedWorkspaceRoot } from '../chats-workspace/paths.js';
import {
  blockPlanModeWrite,
  normalizeModeId,
} from '../tools/plan-write-guard.js';
import { guardCdOutsideWorktree } from '../tools/cwd-guard.js';
import { isPluginToolName } from '../tools/loader.js';
import { validatePluginId } from '../tools/validate.js';
import { parsePluginNamespacedName } from '../tools/bridge.js';
import { executeToolCallBatch } from './tool-batch.js';

const PLAN_SETTINGS_BLOCK =
  'Error: Plan mode does not allow update_settings. Use launch_minnow_app to open Settings.';

const CWD_REQUIRED = 'Error: cwd is required';

/**
 * @param {unknown} raw
 * @returns {string}
 */
function requireCwd(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('cwd is required');
  }
  return raw.trim();
}

/**
 * @param {unknown} raw
 * @returns {Set<string> | null}
 */
function normalizeAllowed(raw) {
  if (raw == null) return null;
  if (raw instanceof Set) return raw;
  if (Array.isArray(raw)) return new Set(raw.map(String));
  throw new Error('allowedToolNames must be an array or Set of tool names');
}

/**
 * @param {string} name
 * @returns {string | null}
 */
function pluginNameError(name) {
  if (!isPluginToolName(name)) return null;
  const parsed = parsePluginNamespacedName(name);
  if (!parsed) {
    return `Error: invalid plugin tool name ${name}`;
  }
  try {
    validatePluginId(parsed.pluginId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
  return null;
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {string | undefined} modeId
 * @returns {string | null}
 */
function httpLayerGuardResult(name, args, modeId) {
  const planWriteBlock = blockPlanModeWrite(modeId, name, args);
  if (planWriteBlock) return planWriteBlock;
  const normalized = normalizeModeId(modeId);
  if (normalized === 'plan' && name === 'update_settings') {
    return PLAN_SETTINGS_BLOCK;
  }
  return null;
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {string} cwd
 * @returns {Record<string, unknown>}
 */
function applyCwdGuard(name, args, cwd) {
  if (name !== 'execute_command') return args;
  if (typeof args.command !== 'string') return args;
  const guarded = guardCdOutsideWorktree(args.command, cwd);
  if (!guarded.redirected) return args;
  return { ...args, command: guarded.command };
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 * @param {{
 *   cwd: string,
 *   modeId?: string | null,
 *   allowedToolNames?: Iterable<string> | Set<string> | null,
 *   toolCallId?: string,
 * }} options
 * @returns {Promise<{ content: string, attachments?: unknown, codeChange?: unknown }>}
 */
export async function executeInProcessTool(name, args = {}, options) {
  if (!options || typeof options !== 'object') {
    return { content: CWD_REQUIRED };
  }

  let cwd;
  try {
    cwd = requireCwd(options.cwd);
  } catch {
    return { content: CWD_REQUIRED };
  }

  if (typeof name !== 'string' || !name.trim()) {
    return { content: 'Error: Missing or invalid "name"' };
  }
  const toolName = name.trim();
  const toolArgs =
    args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};

  const allowed = normalizeAllowed(options.allowedToolNames);
  if (allowed && !allowed.has(toolName)) {
    return { content: `Error: tool "${toolName}" is not in the allowed set` };
  }

  const pluginErr = pluginNameError(toolName);
  if (pluginErr) return { content: pluginErr };

  const modeId =
    typeof options.modeId === 'string' && options.modeId.trim()
      ? options.modeId.trim()
      : undefined;
  const layer = httpLayerGuardResult(toolName, toolArgs, modeId);
  if (layer) return { content: layer };

  let workspaceRoot;
  try {
    workspaceRoot = await validateAllowedWorkspaceRoot(cwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${message}` };
  }

  const guardedArgs = applyCwdGuard(toolName, toolArgs, workspaceRoot);
  if (
    toolName === 'execute_command' &&
    typeof options.toolCallId === 'string' &&
    options.toolCallId.trim() &&
    typeof guardedArgs.toolCallId !== 'string'
  ) {
    guardedArgs.toolCallId = options.toolCallId.trim();
  }

  const out = await executeServerTool(toolName, guardedArgs, { workspaceRoot });
  /** @type {{ content: string, attachments?: unknown, codeChange?: unknown }} */
  const result = { content: String(out.result ?? '') };
  if (Array.isArray(out.attachments) && out.attachments.length > 0) {
    result.attachments = out.attachments;
  }
  if (out.codeChange && typeof out.codeChange === 'object') {
    result.codeChange = out.codeChange;
  }
  return result;
}

/**
 * @param {{
 *   cwd: string,
 *   modeId?: string | null,
 *   allowedToolNames?: Iterable<string> | Set<string> | null,
 * }} options
 * @returns {{
 *   execute: (name: string, args: unknown, ctx?: { toolCallId?: string }) => Promise<{ content: string }>,
 *   runHeadlessToolBatch: (batchOptions: object) => Promise<object[]>,
 *   cwd: string,
 * }}
 */
export function createInProcessToolDispatch(options) {
  const cwd = requireCwd(options?.cwd);
  const modeId = options?.modeId;
  const allowedToolNames = options?.allowedToolNames ?? null;

  async function execute(name, args, ctx) {
    return executeInProcessTool(
      name,
      args && typeof args === 'object' ? args : {},
      {
        cwd,
        modeId,
        allowedToolNames,
        toolCallId: ctx?.toolCallId,
      },
    );
  }

  async function runHeadlessToolBatch(batchOptions = {}) {
    return executeToolCallBatch({
      toolCalls: batchOptions.toolCalls ?? [],
      constrained: batchOptions.constrained,
      signal: batchOptions.signal,
      toolTimeoutMs: batchOptions.toolTimeoutMs,
      execute: batchOptions.execute ?? execute,
      onToolStart: batchOptions.onToolStart,
      onToolDone: batchOptions.onToolDone,
      onParallelSegmentStart: batchOptions.onParallelSegmentStart,
    });
  }

  return { execute, runHeadlessToolBatch, cwd };
}
