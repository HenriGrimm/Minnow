/**
 * Onboarding phase groups — sidebar navigation and progress context.
 */

import type { OnboardingStep, OnboardingStepId } from './types';

/** Logical setup phases shown in the left rail. */
export interface OnboardingPhase {
  id: string;
  label: string;
  stepIds: readonly OnboardingStepId[];
}

export const ONBOARDING_PHASES: OnboardingPhase[] = [
  { id: 'start', label: 'Welcome', stepIds: ['welcome'] },
  { id: 'look', label: 'Appearance', stepIds: ['theme'] },
  { id: 'apps', label: 'Apps', stepIds: ['apps'] },
  {
    id: 'models',
    label: 'Models',
    stepIds: ['provider-choice', 'provider-local', 'provider-managed', 'provider-cloud', 'provider-cli', 'model-pick'],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    stepIds: ['extras', 'github', 'permissions', 'memory', 'api-keys', 'context7'],
  },
  { id: 'finish', label: 'Finish', stepIds: ['done'] },
];

/** Phases that contain at least one applicable step. */
export function getApplicablePhases(steps: OnboardingStep[]): OnboardingPhase[] {
  const ids = new Set(steps.map((s) => s.id));
  return ONBOARDING_PHASES.filter((phase) => phase.stepIds.some((id) => ids.has(id)));
}

/** Phase index for a step id within the applicable phase list. */
export function resolvePhaseIndex(phases: OnboardingPhase[], stepId: OnboardingStepId): number {
  const idx = phases.findIndex((phase) => phase.stepIds.includes(stepId));
  return idx >= 0 ? idx : 0;
}

/** Human-readable step position (1-based). */
export function formatStepPosition(index: number, total: number): string {
  return `Step ${index + 1} of ${total}`;
}
