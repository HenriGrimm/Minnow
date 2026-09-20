import { ORCHESTRATE_PLANS_PREFIX } from '../plans/plan-path';
import { validatePlanSaveNoCodeSnippets } from '../super-plan/no-code-guard';
import { extractPathLikeArgs } from '../../tools/path-args';
import { normalizeModeId, type ModeId } from './types';

const PLANS_ROOT = ORCHESTRATE_PLANS_PREFIX.replace(/\/$/, '');
const PLANS_PREFIX_LOWER = ORCHESTRATE_PLANS_PREFIX.toLowerCase();
const SUPER_PLAN_REFERENCES_PREFIX = `${ORCHESTRATE_PLANS_PREFIX}references/`;
const SUPER_PLAN_REFERENCES_PREFIX_LOWER = SUPER_PLAN_REFERENCES_PREFIX.toLowerCase();

/** Super Plan reference artifacts (under documentation/plans/references/**). */
const SUPER_PLAN_REFERENCE_BASENAMES = new Set([
  'research-artifact.md',
  'build-spec.md',
]);

const SUPER_PLAN_REFERENCE_SUFFIX_RE = /-(?:spec|research)\.md$/i;

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
  'delete_path',
  'move_file',
  'copy_file',
  'create_pdf',
  'create_spreadsheet',
  'create_word_document',
]);

/** Args carrying written content, per plan-scoped write tool. */
const PLAN_CONTENT_ARG_KEYS: Record<string, readonly string[]> = {
  save_file: ['content'],
  append_file: ['content'],
  insert_at_line: ['content'],
  replace_text_in_file: ['replace'],
};

/**
 * True when a workspace-relative path is the plans root or a subdirectory.
 */
export function isUnderDocumentationPlans(relativePath: string): boolean {
  const trimmed = relativePath.trim().replace(/\\/g, '/');
  if (!trimmed) return false;
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
 * True when the path is under documentation/plans/references/.
 */
export function isUnderSuperPlanReferences(relativePath: string): boolean {
  const trimmed = relativePath.trim().replace(/\\/g, '/');
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  return (
    lower === SUPER_PLAN_REFERENCES_PREFIX_LOWER.slice(0, -1) ||
    lower.startsWith(SUPER_PLAN_REFERENCES_PREFIX_LOWER)
  );
}

/**
 * True when Super Plan may save a research-artifact or build-spec under references/.
 */
export function isSuperPlanReferenceArtifactPath(relativePath: string): boolean {
  const trimmed = relativePath.trim().replace(/\\/g, '/');
  if (!trimmed) return false;
  if (!isUnderSuperPlanReferences(trimmed)) return false;
  const basename = trimmed.split('/').pop()?.toLowerCase() ?? '';
  if (SUPER_PLAN_REFERENCE_BASENAMES.has(basename)) return true;
  return SUPER_PLAN_REFERENCE_SUFFIX_RE.test(basename);
}

function isPlanFamilyMode(modeId: ModeId | string): boolean {
  return modeId === 'plan' || modeId === 'super-plan';
}

function isAllowedPlanFamilyWritePath(modeId: ModeId, relativePath: string): boolean {
  if (isPlanMarkdownPath(relativePath)) return true;
  if (modeId === 'super-plan' && isSuperPlanReferenceArtifactPath(relativePath)) {
    return true;
  }
  return false;
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
  if (!isPlanFamilyMode(normalized)) return null;

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
      if (!isAllowedPlanFamilyWritePath(normalized, p)) {
        const hint =
          normalized === 'super-plan'
            ? `${ORCHESTRATE_PLANS_PREFIX}*.md or ${SUPER_PLAN_REFERENCES_PREFIX}*-spec.md / *-research.md`
            : `${ORCHESTRATE_PLANS_PREFIX}*.md`;
        return `Error: ${normalized === 'super-plan' ? 'Super Plan' : 'Plan'} mode may only ${toolName} to ${hint} (got "${p}")`;
      }
      continue;
    }
    if (toolName === 'make_directory' && !isUnderDocumentationPlans(p)) {
      return `Error: Plan mode may only make_directory under ${PLANS_ROOT}/ (got "${p}")`;
    }
  }

  return null;
}

/**
 * Returns an error when Super Plan save_file content violates the no-code-snippet rule.
 */
export function blockSuperPlanCodeSnippets(
  modeId: ModeId | string | null | undefined,
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const normalized = normalizeModeId(typeof modeId === 'string' ? modeId : modeId ?? undefined);
  if (normalized !== 'super-plan') return null;
  const keys = PLAN_CONTENT_ARG_KEYS[toolName];
  if (!keys) return null;
  for (const key of keys) {
    const content = args[key];
    if (typeof content !== 'string') continue;
    const violation = validatePlanSaveNoCodeSnippets(content);
    if (violation) return `Error: ${violation}`;
  }
  return null;
}

/**
 * Combined Plan-family write guard including Super Plan content validation.
 */
export function blockPlanModeWriteWithContent(
  modeId: ModeId | string | null | undefined,
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const pathBlock = blockPlanModeWrite(modeId, toolName, args);
  if (pathBlock) return pathBlock;
  return blockSuperPlanCodeSnippets(modeId, toolName, args);
}
