import type { RoutingForm } from '../../ui/routing-form';
import { renderStepHeader, el } from '../ui-helpers';
import type { OnboardingStep } from '../types';

let form: RoutingForm | undefined;
export const routingStep: OnboardingStep = {
  id: 'model-routing', title: 'Model routing', canSkip: true,
  isApplicable: (ctx) => Boolean(ctx.providerId && ctx.modelId),
  render(container, ctx, actions) {
    renderStepHeader(container, routingStep, actions.stepIndex, actions.totalSteps);
    container.append(el('p', 'mn-onboarding-step-desc', 'Choose separate models for supporting tasks, or let them follow the model you are using. You can change routing from Models in the top bar.'));
    const host = document.createElement('div'); container.append(host);
    let alive = true;
    let mounted: RoutingForm | undefined;
    actions.setPrimaryEnabled(false);
    void import('../../ui/routing-form').then((module) => {
      if (!alive) return;
      mounted = module.mountRoutingForm(host, { onReady: () => { if (alive) actions.setPrimaryEnabled(true); } });
      form = mounted;
    }).catch(() => { if (alive) host.textContent = 'Could not load routing. Skip this step and configure Models later.'; });
    return () => { alive = false; mounted?.dispose(); if (form === mounted) form = undefined; };
  },
  async commit() { await form?.commit(); },
};
