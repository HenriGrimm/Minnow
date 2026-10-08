import type { AgentCliStatus } from '../../models/agent-clis';
import { mountCliPanel, teardownCliPanel } from '../../ui/models/cli-panel';
import type { OnboardingStep } from '../types';
import { recordStepProgress } from '../state-core';
import { el, renderStepHeader } from '../ui-helpers';

export function isOnboardingCliReady(status: AgentCliStatus): boolean {
  return status.installed && status.enabled
    && (status.authStatus === 'signed-in' || status.authStatus === 'token');
}

export const providerCliStep: OnboardingStep = {
  id: 'provider-cli',
  title: 'CLI agents',
  canSkip: true,
  isApplicable: (ctx) => ctx.providerPath === 'cli',
  render(container, ctx, actions) {
    container.replaceChildren();
    container.className = 'mn-onboarding-step';
    renderStepHeader(container, providerCliStep, actions.stepIndex, actions.totalSteps);
    container.appendChild(el('p', 'mn-onboarding-step-desc',
      'Install or sign in to a CLI agent, then enable it and verify its status.'));
    const label = el('label', 'mn-onboarding-muted', 'Default CLI agent');
    const select = el('select', 'mn-onboarding-field') as HTMLSelectElement;
    select.setAttribute('aria-label', 'Default CLI agent');
    label.appendChild(select);
    const panel = el('div', 'mn-onboarding-cli-panel');
    container.append(label, panel);
    actions.setPrimaryLabel('Continue');
    actions.setPrimaryEnabled(false);
    const savedProviderId = ctx.providerId;
    const choose = (): void => {
      const providerId = select.value || null;
      if (ctx.providerId !== providerId) actions.patchContext({ providerId, modelId: null });
      actions.setPrimaryEnabled(Boolean(select.value));
    };
    select.addEventListener('change', choose);
    let disposed = false;
    void mountCliPanel({
      container: panel,
      showCommandInstructions: true,
      onStatusChange(statuses) {
        if (disposed) return;
        const previous = select.value || savedProviderId;
        const ready = statuses.filter(isOnboardingCliReady);
        select.replaceChildren();
        if (!ready.length) {
          const option = document.createElement('option');
          option.value = '';
          option.textContent = 'Enable a verified CLI agent to continue';
          select.appendChild(option);
        }
        for (const status of ready) {
          const option = document.createElement('option');
          option.value = status.providerId;
          option.textContent = status.label;
          select.appendChild(option);
        }
        if (ready.some((status) => status.providerId === previous)) select.value = previous!;
        select.disabled = !ready.length;
        if (statuses.length) choose();
        else actions.setPrimaryEnabled(false);
      },
    });
    return () => {
      disposed = true;
      teardownCliPanel();
    };
  },
  commit(ctx) {
    ctx.state = recordStepProgress(ctx.state, 'provider-cli', {
      done: Boolean(ctx.providerId),
      data: { path: 'cli', providerId: ctx.providerId },
    });
  },
};
