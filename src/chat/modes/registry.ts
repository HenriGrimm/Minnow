import { loadPromptById } from '../prompts/prompt-loader';
import type { PromptProfile } from '../prompts/types';
import {
  DEFAULT_MODE_ID,
  MODE_IDS,
  type ModeDefinition,
  type ModeId,
} from './types';
import { MODE_ALLOWED_GROUPS, allowGroupsToolPolicy } from './tool-groups';

export { DEFAULT_MODE_ID, MODE_IDS, isModeId, normalizeModeId } from './types';

const MODE_DEFINITIONS: ModeDefinition[] = [
  {
    id: 'general',
    label: 'General',
    description:
      'Everyday Q&A and brainstorming; broad tool access with approval before each run.',
    promptId: 'general',
    toolPolicy: allowGroupsToolPolicy('general', MODE_ALLOWED_GROUPS.general),
  },
  {
    id: 'build',
    label: 'Build',
    description: 'Default development mode with broad tool access.',
    promptId: 'build',
    toolPolicy: allowGroupsToolPolicy('build', MODE_ALLOWED_GROUPS.build),
  },
  {
    id: 'plan',
    label: 'Plan',
    description:
      'Analyze and plan; limited file writes (plan doc only) with shell and read tools.',
    promptId: 'plan',
    toolPolicy: allowGroupsToolPolicy('plan', MODE_ALLOWED_GROUPS.plan),
  },
  {
    id: 'super-plan',
    label: 'Super Plan',
    description:
      'Extended planning with sub-agent research; write plans and reference artifacts only.',
    promptId: 'super-plan',
    toolPolicy: allowGroupsToolPolicy('super-plan', MODE_ALLOWED_GROUPS['super-plan']),
  },
  {
    id: 'orchestrate',
    label: 'Orchestrate',
    description: 'Open a multi-agent board from a plan. Not a chat — parsePlan is intake.',
    promptId: 'orchestrate',
    toolPolicy: allowGroupsToolPolicy('orchestrate', MODE_ALLOWED_GROUPS.orchestrate),
  },
  {
    id: 'debug',
    label: 'Debug',
    description:
      'Investigate issues and root causes; file and triage via Issues and issue_* tools.',
    promptId: 'debug',
    toolPolicy: allowGroupsToolPolicy('debug', MODE_ALLOWED_GROUPS.debug),
  },
  {
    id: 'onboarding',
    label: 'Onboarding',
    description:
      'First-run tour guide — introduces Minnow, learns about the user, and demos tools live.',
    promptId: 'onboarding',
    toolPolicy: allowGroupsToolPolicy('onboarding', MODE_ALLOWED_GROUPS.onboarding),
  },
];

/**
 * Fixed modes in display order (General first).
 *
 * Super Plan is kept in {@link MODE_DEFINITIONS} so `getMode` still resolves
 * persisted records, but it is filtered out of every picker while the surface
 * is disabled for release.
 */
export function listModes(): ModeDefinition[] {
  return MODE_DEFINITIONS.filter((m) => m.id !== 'super-plan');
}

/** Composer mode strip (excludes Orchestrate, Super Plan, and Onboarding). */
export function listComposerModes(): ModeDefinition[] {
  return MODE_DEFINITIONS.filter(
    (m) =>
      m.id !== 'orchestrate' &&
      m.id !== 'super-plan' &&
      m.id !== 'onboarding',
  );
}

export function getMode(id: ModeId): ModeDefinition {
  const resolvedId = id === 'desktop' || id === 'email' ? 'general' : id;
  const mode = MODE_DEFINITIONS.find((m) => m.id === resolvedId);
  if (!mode) {
    throw new Error(`Unknown mode id: ${id}`);
  }
  return mode;
}

/**
 * Logical relative path for built-in mode prompt files (used in tests).
 */
export function resolveModePromptPath(id: ModeId, profile: 'full' | 'lite'): string {
  const resolvedId = id === 'desktop' || id === 'email' ? 'general' : id;
  return `modes/${resolvedId}.${profile}.md`;
}

/**
 * Load mode prompt body for compose / tests.
 */
export function loadModePromptBody(id: ModeId, profile: 'full' | 'lite'): string {
  const resolvedId = id === 'desktop' || id === 'email' ? 'general' : id;
  const loadProfile: PromptProfile = profile;
  const loaded = loadPromptById('mode', resolvedId, loadProfile);
  return loaded?.body?.trim() ?? '';
}
