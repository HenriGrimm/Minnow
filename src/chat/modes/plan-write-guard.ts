import { ORCHESTRATE_PLANS_PREFIX } from '../plans/plan-path';
import { extractPathLikeArgs } from '../../tools/path-args';
import { normalizeModeId, type ModeId } from './types';

const PLANS_ROOT = ORCHESTRATE_PLANS_PREFIX.replace(/\/$/, '');
const PLANS_PREFIX_LOWER = ORCHESTRATE_PLANS_PREFIX.toLowerCase();
/** Tools Plan mode may use to edit an existing plan file in place. */
const PLAN_EDIT_TOOLS = new Set([
  'append_file',
  'insert_at_line',
  'replace_text_in_file',
]);

/** Tools Plan mode may use to create the plans tree or write plan files. */
const PLAN_SCOPED_WRITE_TOOLS = new Set([
  'save_file',
  'make_directory',
  ...PLAN_EDIT_TOOLS,
]);

/** Other mutation tools remain blocked even if policy regresses. */
const PLAN_BLOCKED_WRITE_TOOLS = new Set([
  'action_run', 'action_cancel', 'action_command', 'release_manage', 'release_asset',
  'plugin_manage',
  'apply_patch',
  'delete_path',
  'move_file',
  'copy_file',
  'create_pdf',
  'create_spreadsheet',
  'create_word_document',
  'godot_control',
]);

/**
 * True when a workspace-relative path is the plans root or a subdirectory.
 */
export function isUnderDocumentationPlans(relativePath: string): boolean {
  const trimmed = relativePath.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed.split('/').includes('..')) return false;
  const lower = trimmed.toLowerCase();
  return lower === PLANS_PREFIX_LOWER.slice(0, -1) || lower.startsWith(PLANS_PREFIX_LOWER);
}

/**
 * True when the path is a markdown file under documentation/plans/.
 */
export function isPlanMarkdownPath(relativePath: string): boolean {
  const trimmed = relativePath.trim().replace(/\\/g, '/');
  if (!trimmed.toLowerCase().endsWith('.md')) return false;
  return isUnderDocumentationPlans(trimmed);
}

/**
 * Returns an error message when Plan mode blocks this write, or null when allowed.
 */
export function blockPlanModeWrite(
  modeId: ModeId | string | null | undefined,
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const rawMode = typeof modeId === 'string' ? modeId : modeId ?? undefined;
  const normalized = normalizeModeId(rawMode);
  if (normalized !== 'plan') return null;

  if (toolName === 'update_settings') {
    return 'Error: Plan mode does not allow update_settings. Use launch_minnow_app to open Settings.';
  }

  if (PLAN_BLOCKED_WRITE_TOOLS.has(toolName)) {
    return `Error: Plan mode only allows writing markdown plans under ${ORCHESTRATE_PLANS_PREFIX}`;
  }

  if (!PLAN_SCOPED_WRITE_TOOLS.has(toolName)) return null;

  const paths = extractPathLikeArgs(toolName, args);
  if (paths.length === 0) {
    return 'Error: path is required';
  }

  for (const p of paths) {
    if (toolName === 'save_file' || PLAN_EDIT_TOOLS.has(toolName)) {
      if (!isPlanMarkdownPath(p)) {
        return `Error: Plan mode may only ${toolName} to ${ORCHESTRATE_PLANS_PREFIX}*.md (got "${p}")`;
      }
      continue;
    }
    if (toolName === 'make_directory' && !isUnderDocumentationPlans(p)) {
      return `Error: Plan mode may only make_directory under ${PLANS_ROOT}/ (got "${p}")`;
    }
  }

  return null;
}

export const blockPlanModeWriteWithContent = blockPlanModeWrite;
