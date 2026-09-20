/**
 * Server-side Plan / Super Plan write guard (mirrors src/chat/modes/plan-write-guard.ts).
 */

const ORCHESTRATE_PLANS_PREFIX = 'documentation/plans/';
const PLANS_ROOT = ORCHESTRATE_PLANS_PREFIX.replace(/\/$/, '');
const PLANS_PREFIX_LOWER = ORCHESTRATE_PLANS_PREFIX.toLowerCase();
const SUPER_PLAN_REFERENCES_PREFIX = `${ORCHESTRATE_PLANS_PREFIX}references/`;
const SUPER_PLAN_REFERENCES_PREFIX_LOWER = SUPER_PLAN_REFERENCES_PREFIX.toLowerCase();

const SUPER_PLAN_REFERENCE_BASENAMES = new Set([
  'research-artifact.md',
  'build-spec.md',
]);

const SUPER_PLAN_REFERENCE_SUFFIX_RE = /-(?:spec|research)\.md$/i;

const MODE_IDS = new Set(['build', 'plan', 'super-plan', 'orchestrate']);

/** Tools Plan mode may use to edit an existing plan file in place. */
const PLAN_EDIT_TOOLS = new Set([
  'append_file',
  'insert_at_line',
  'replace_text_in_file',
]);

const PLAN_SCOPED_WRITE_TOOLS = new Set([
  'save_file',
  'make_directory',
  ...PLAN_EDIT_TOOLS,
]);

const PLAN_BLOCKED_WRITE_TOOLS = new Set([
  'plugin_manage',
  'delete_path',
  'move_file',
  'copy_file',
  'create_pdf',
  'create_spreadsheet',
  'create_word_document',
]);

/** Argument keys that hold paths for plan write checks. */
const TOOL_PATH_ARG_KEYS = {
  save_file: ['path'],
  make_directory: ['path'],
  append_file: ['path'],
  insert_at_line: ['path'],
  replace_text_in_file: ['path'],
  delete_path: ['path'],
  move_file: ['source', 'destination'],
  copy_file: ['source', 'destination'],
};

/**
 * @param {string | null | undefined} value
 * @returns {'build' | 'plan' | 'super-plan' | 'orchestrate'}
 */
export function normalizeModeId(value) {
  if (typeof value === 'string' && MODE_IDS.has(value)) {
    return value;
  }
  return 'build';
}

/**
 * @param {unknown} body
 * @returns {string | undefined}
 */
export function resolveModeIdFromToolsBody(body) {
  if (body && typeof body === 'object' && body.planMode === true) {
    return 'plan';
  }
  const modeId = body?.modeId;
  return typeof modeId === 'string' && modeId.trim() ? modeId.trim() : undefined;
}

/**
 * @param {string} relativePath
 */
export function isUnderDocumentationPlans(relativePath) {
  const trimmed = relativePath.trim().replace(/\\/g, '/');
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  return lower === PLANS_PREFIX_LOWER.slice(0, -1) || lower.startsWith(PLANS_PREFIX_LOWER);
}

/**
 * @param {string} relativePath
 */
export function isPlanMarkdownPath(relativePath) {
  const trimmed = relativePath.trim().replace(/\\/g, '/');
  if (!trimmed.toLowerCase().endsWith('.md')) return false;
  return isUnderDocumentationPlans(trimmed);
}

/**
 * @param {string} relativePath
 */
export function isUnderSuperPlanReferences(relativePath) {
  const trimmed = relativePath.trim().replace(/\\/g, '/');
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  return (
    lower === SUPER_PLAN_REFERENCES_PREFIX_LOWER.slice(0, -1) ||
    lower.startsWith(SUPER_PLAN_REFERENCES_PREFIX_LOWER)
  );
}

/**
 * @param {string} relativePath
 */
export function isSuperPlanReferenceArtifactPath(relativePath) {
  const trimmed = relativePath.trim().replace(/\\/g, '/');
  if (!trimmed) return false;
  if (!isUnderSuperPlanReferences(trimmed)) return false;
  const basename = trimmed.split('/').pop()?.toLowerCase() ?? '';
  if (SUPER_PLAN_REFERENCE_BASENAMES.has(basename)) return true;
  return SUPER_PLAN_REFERENCE_SUFFIX_RE.test(basename);
}

/**
 * @param {string} modeId
 */
function isPlanFamilyMode(modeId) {
  return modeId === 'plan' || modeId === 'super-plan';
}

/**
 * @param {string} modeId
 * @param {string} relativePath
 */
function isAllowedPlanFamilyWritePath(modeId, relativePath) {
  if (isPlanMarkdownPath(relativePath)) return true;
  if (modeId === 'super-plan' && isSuperPlanReferenceArtifactPath(relativePath)) {
    return true;
  }
  return false;
}

/**
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @returns {string[]}
 */
function extractPathLikeArgs(toolName, args) {
  const keys = TOOL_PATH_ARG_KEYS[toolName];
  const out = [];
  if (keys) {
    for (const key of keys) {
      const v = args[key];
      if (typeof v === 'string' && v.trim()) {
        out.push(v.trim());
      }
    }
  }
  return out;
}

/**
 * Returns an error message when Plan mode blocks this write, or null when allowed.
 *
 * @param {string | null | undefined} modeId
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @returns {string | null}
 */
export function blockPlanModeWrite(modeId, toolName, args) {
  const normalized = normalizeModeId(
    typeof modeId === 'string' ? modeId : modeId ?? undefined,
  );
  if (!isPlanFamilyMode(normalized)) return null;

  if (PLAN_BLOCKED_WRITE_TOOLS.has(toolName)) {
    return `Error: Plan mode only allows writing markdown plans under ${ORCHESTRATE_PLANS_PREFIX}`;
  }

  if (!PLAN_SCOPED_WRITE_TOOLS.has(toolName)) return null;

  const paths = extractPathLikeArgs(toolName, args ?? {});
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
