/**
 * Capability-matrix probe wave id lists (shared; no imports from probe-requirements).
 */

/** Phase 2c capability ids (files, docs, git, code-shell). */
export const PHASE_2C_WORKSPACE_CAPABILITY_IDS = [
  'files-list-read',
  'files-read-document',
  'files-save-append',
  'files-replace-text',
  'files-insert-range',
  'files-grep',
  'docs-create-office',
  'git-read',
  'git-write',
  'code-execute-command',
  'code-background-cmds',
  'code-run-js-py',
  'code-command-log',
  'code-repo-intel',
] as const;

/** Auto probes with no `requires` — runnable without tool server / workspace (phase 2b). */
export const PHASE_2B_NO_REQUIREMENT_CAPABILITY_IDS = [
  'core-streaming',
  'core-tool-calling',
  'core-json-args',
  'core-no-hallucinated-tools',
  'core-system-prompt',
  'core-reasoning',
] as const;

/** Phase 2d — emit-only / side-effect tool probes (no workspace requirement). */
export const PHASE_2D_EMIT_ONLY_CAPABILITY_IDS = [
  'web-search',
  'web-fetch',
  'web-wikipedia',
  'agents-spawn-sub-agent',
  'agents-issue-tools',
  'agents-issue-tools-v2',
  'knowledge-brain-read',
  'knowledge-brain-write',
  'knowledge-minnow-docs',
  'knowledge-save-memory',
  'apps-settings-appearance',
  'workflow-load-skill',
  'workflow-launch-code',
  'browser-navigate',
  'browser-snapshot',
  'browser-eval',
  'agents-sub-agent-control',
  'knowledge-recall',
] as const;

/** Phase 2e — conditional probes (workspace / git / LSP / vision gates). */
export const PHASE_2E_CONDITIONAL_CAPABILITY_IDS = [
  'core-parallel-tools',
  'core-tool-loop',
  'core-long-context',
  'lsp-diagnostics',
  'agents-todo-write',
  'features-chat-title',
  'features-markdown',
] as const;

/** Phase 2f — delegated suite probes and remaining derived rows. */
export const PHASE_2F_DELEGATED_DERIVED_CAPABILITY_IDS = [
  'core-vision',
  'mode-impeccable',
  'features-skills',
] as const;

export const PHASE_2B_ID_SET = new Set<string>(PHASE_2B_NO_REQUIREMENT_CAPABILITY_IDS);
export const PHASE_2C_ID_SET = new Set<string>(PHASE_2C_WORKSPACE_CAPABILITY_IDS);
export const PHASE_2D_ID_SET = new Set<string>(PHASE_2D_EMIT_ONLY_CAPABILITY_IDS);
export const PHASE_2E_ID_SET = new Set<string>(PHASE_2E_CONDITIONAL_CAPABILITY_IDS);
export const PHASE_2F_ID_SET = new Set<string>(PHASE_2F_DELEGATED_DERIVED_CAPABILITY_IDS);

export type CapabilityMatrixProbeWave = '2b' | '2c' | '2d' | '2e' | '2f';

/** Resolve rollout wave for an auto capability id. */
export function probeWaveForCapabilityId(
  capabilityId: string,
): CapabilityMatrixProbeWave | null {
  if (PHASE_2B_ID_SET.has(capabilityId)) return '2b';
  if (PHASE_2C_ID_SET.has(capabilityId)) return '2c';
  if (PHASE_2D_ID_SET.has(capabilityId)) return '2d';
  if (PHASE_2E_ID_SET.has(capabilityId)) return '2e';
  if (PHASE_2F_ID_SET.has(capabilityId)) return '2f';
  return null;
}
