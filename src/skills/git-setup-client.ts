/**
 * Client hooks for /git-setup — programmatic baseline .gitignore before the model runs.
 */

import { BUILT_IN_TOOLS, type OpenAIFunctionDefinition } from '../tools/definitions';
import { ensureBaselineGitignore } from '../state/baseline-gitignore';

export const GIT_SETUP_SKILL_ID = 'git-setup';

/**
 * Built-in tools listed in skills/git-setup/SKILL.md.
 */
export const GIT_SETUP_SKILL_TOOL_IDS = [
  'execute_command',
  'read_command_log',
  'list_running_commands',
  'stop_command',
  'git_add',
  'git_commit',
  'save_file',
] as const;

/** Add git-setup skill tools when missing from the turn catalog. */
export function injectGitSetupSkillTools(
  defs: OpenAIFunctionDefinition[],
): OpenAIFunctionDefinition[] {
  if (!defs.length) return defs;
  const existing = new Set(defs.map((d) => d.function.name));
  const extra: OpenAIFunctionDefinition[] = [];
  for (const tool of BUILT_IN_TOOLS) {
    if (
      (GIT_SETUP_SKILL_TOOL_IDS as readonly string[]).includes(tool.id) &&
      !existing.has(tool.id)
    ) {
      extra.push(tool.definition);
    }
  }
  return extra.length ? [...defs, ...extra] : defs;
}

/**
 * Ensure baseline .gitignore exists when starting a git-setup skill turn.
 * Safe to call on every turn; never overwrites an existing file.
 */
export async function prepareGitSetupTurn(workspaceRoot?: string): Promise<void> {
  await ensureBaselineGitignore(workspaceRoot);
}
