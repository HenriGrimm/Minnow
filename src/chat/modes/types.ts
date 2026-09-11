/** Stable ids — do not rename without migration. */
export type ModeId =
  | 'general'
  | 'desktop'
  | 'email'
  | 'build'
  | 'plan'
  | 'super-plan'
  | 'orchestrate'
  | 'debug'
  | 'onboarding';

export const DEFAULT_MODE_ID: ModeId = 'build';

export const MODE_IDS: readonly ModeId[] = [
  'general',
  'desktop',
  'email',
  'build',
  'plan',
  'super-plan', // Phase 0 plan-mode overhaul — sub-item of Plan segment (not composer top-level)
  'orchestrate',
  'debug',
  'onboarding',
] as const;

/** Type guard for persisted mode ids. */
export function isModeId(value: string): value is ModeId {
  return (MODE_IDS as readonly string[]).includes(value);
}

/**
 * Normalize persisted or unknown values to a valid ModeId.
 *
 * Super Plan is disabled for release: it stays a valid persisted id so existing
 * records still load, but every runtime read collapses it to Plan mode. That
 * single mapping is what disables the whole surface — the pipeline, the
 * composer routing and the Super Plan page all key off this normalized id.
 */
export function normalizeModeId(value: string | null | undefined): ModeId {
  if (value === 'desktop' || value === 'email') return 'general';
  if (value === 'super-plan') return 'plan';
  if (value && isModeId(value)) return value;
  return DEFAULT_MODE_ID;
}

export type ToolPolicyAction = 'allow' | 'deny' | 'ask';

/** Wildcard keys match tool function names from definitions.ts (same as tool id). */
export interface ModeToolPolicy {
  /** Default for tools not listed in `tools`. */
  default: ToolPolicyAction;
  /** Per-tool overrides, e.g. execute_command: deny */
  tools?: Record<string, ToolPolicyAction>;
}

export interface ModeDefinition {
  id: ModeId;
  label: string;
  description: string;
  /** Prompt file id (usually same as ModeId). */
  promptId: ModeId;
  toolPolicy: ModeToolPolicy;
}
