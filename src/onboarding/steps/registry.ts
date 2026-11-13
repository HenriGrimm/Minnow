/**
 * The provider path is the only setup required to start chatting.
 */

import type { OnboardingContext, OnboardingStep } from '../types';
import {
  providerChoiceStep,
  providerLocalStep,
  providerCloudStep,
} from './provider';
import { providerManagedStep } from './managed';
import { providerCliStep } from './cli';
import { modelPickStep } from './model';

export const ONBOARDING_STEPS: OnboardingStep[] = [
  providerChoiceStep,
  providerLocalStep,
  providerManagedStep,
  providerCloudStep,
  providerCliStep,
  modelPickStep,
];

export function getApplicableSteps(ctx: OnboardingContext): OnboardingStep[] {
  return ONBOARDING_STEPS.filter((step) => step.isApplicable(ctx));
}

export function resolveStepIndex(steps: OnboardingStep[], ctx: OnboardingContext): number {
  const { lastStep } = ctx.state;
  const savedIndex = steps.findIndex((step) => step.id === lastStep);
  if (savedIndex >= 0) {
    // A committed provider can go straight to model selection on resume.
    const next = steps[savedIndex + 1];
    if (ctx.providerId && lastStep && ctx.state.steps[lastStep]?.done && next?.id === 'model-pick') {
      return savedIndex + 1;
    }
    return savedIndex;
  }
  // Older setups may have stopped on an optional page after connecting a model.
  const selection = steps.at(-1);
  return ctx.providerId && selection
    && (selection.id === 'model-pick' || ctx.state.steps[selection.id]?.done)
    ? steps.length - 1 : 0;
}
