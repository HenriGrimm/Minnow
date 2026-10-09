/**
 * Ordered onboarding step registry (MIN-233 flow).
 */

import type { OnboardingStep } from '../types';
import { welcomeStep } from './welcome';
import { themeStep } from './theme';
import {
  providerChoiceStep,
  providerLocalStep,
  providerCloudStep,
} from './provider';
import { providerManagedStep } from './managed';
import { providerCliStep } from './cli';
import { modelPickStep } from './model';
import { extrasStep } from './extras';
import { githubStep } from './github';
import { apiKeysStep } from './api-keys';
import { context7Step } from './context7';
import { permissionsStep, memoryStep, doneStep } from './remaining';

/** Full wizard step order; controller filters with isApplicable. */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  welcomeStep,
  themeStep,
  providerChoiceStep,
  providerLocalStep,
  providerManagedStep,
  providerCloudStep,
  providerCliStep,
  modelPickStep,
  apiKeysStep,
  extrasStep,
  githubStep,
  permissionsStep,
  memoryStep,
  context7Step,
  doneStep,
];

export function getApplicableSteps(ctx: import('../types').OnboardingContext): OnboardingStep[] {
  return ONBOARDING_STEPS.filter((step) => step.isApplicable(ctx));
}

export function resolveStepIndex(
  steps: OnboardingStep[],
  stepId: import('../types').OnboardingStepId | null,
): number {
  if (!stepId) return 0;
  if (stepId === 'apps') stepId = 'provider-choice';
  const idx = steps.findIndex((s) => s.id === stepId);
  return idx >= 0 ? idx : 0;
}
