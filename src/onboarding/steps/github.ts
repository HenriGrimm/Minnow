import { mountGitHubAccount } from '../../ui/github-account';
import { renderStepHeader } from '../ui-helpers';
import { recordStepProgress } from '../state-core';
import type { OnboardingStep } from '../types';

export const githubStep: OnboardingStep = {
  id: 'github',
  title: 'Connect GitHub',
  canSkip: true,
  isApplicable: (ctx) => ctx.serverAvailable,
  render(container, ctx, actions) {
    container.replaceChildren();
    container.className = 'mn-onboarding-step';
    renderStepHeader(container, githubStep, actions.stepIndex, actions.totalSteps);
    actions.setPrimaryLabel('Continue');
    actions.setPrimaryEnabled(false);
    const hint = document.createElement('p');
    hint.className = 'mn-onboarding-step-desc';
    hint.textContent = 'Bring your repositories into your build workflow. You can skip this step and connect later in Settings → GitHub.';
    container.append(hint);
    return mountGitHubAccount(container, (connected) => {
      actions.setPrimaryEnabled(connected);
      ctx.state = recordStepProgress(ctx.state, 'github', { done: connected, skipped: false });
    }, 'h3');
  },
  commit() {},
};
