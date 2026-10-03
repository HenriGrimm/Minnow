/**
 * Choose your apps — pick which optional Minnow apps appear in the dock.
 * When no optional apps are released yet, shows Always included + Coming soon.
 */

import '../../styles/app-picker.css';

import {
  listCoreReleasedApps,
  listOptionalReleasedApps,
} from '../../os/app-registry';
import {
  listEnabledOptionalAppIds,
  setEnabledOptionalApps,
} from '../../os/app-preferences';
import {
  appendAppPickerCoreNote,
  appendAppPickerGroup,
} from '../../os/app-picker-ui';
import { el, renderStepHeader, settingsLink } from '../ui-helpers';
import type { OnboardingContext, OnboardingStep } from '../types';
import { recordStepProgress } from '../state-core';
import type { AppId } from '../../os/types';

/** Working selection for optional apps (defaults from current preferences). */
let selectedOptional = new Set<AppId>();

function syncSelectionFromPrefs(): void {
  selectedOptional = new Set(listEnabledOptionalAppIds());
}

export const appsStep: OnboardingStep = {
  id: 'apps',
  title: 'Choose your apps',
  canSkip: true,

  isApplicable() {
    return true;
  },

  render(container, _ctx, actions) {
    container.innerHTML = '';
    container.className = 'mn-onboarding-step mn-onboarding-step--apps';

    syncSelectionFromPrefs();

    renderStepHeader(container, appsStep, actions.stepIndex, actions.totalSteps);

    const optionalApps = listOptionalReleasedApps();
    const hasOptional = optionalApps.length > 0;

    container.appendChild(
      el(
        'p',
        'mn-onboarding-step-desc',
        hasOptional
          ? 'Pick optional apps for the dock. Change anytime in Settings.'
          : 'These apps are included in your workspace.',
      ),
    );

    appendAppPickerCoreNote(container, {
      apps: listCoreReleasedApps(),
    });

    if (hasOptional) {
      appendAppPickerGroup(container, {
        title: 'Optional apps',
        apps: optionalApps,
        mode: 'selectable',
        isSelected: (id) => selectedOptional.has(id),
        onToggle: (id, selected) => {
          if (selected) selectedOptional.add(id);
          else selectedOptional.delete(id);
        },
        onBulkSet: (selected) => {
          if (selected) {
            for (const app of optionalApps) selectedOptional.add(app.id);
          } else {
            selectedOptional.clear();
          }
        },
      });
    }

    const foot = el('p', 'mn-onboarding-footnote');
    foot.append('Change anytime in ');
    foot.appendChild(settingsLink('Settings → Apps', 'apps.visibility'));
    container.appendChild(foot);

    actions.setPrimaryLabel('Continue');
    actions.setPrimaryEnabled(true);
  },

  commit(ctx) {
    const enabled = [...selectedOptional];
    setEnabledOptionalApps(enabled);

    ctx.state = recordStepProgress(ctx.state, 'apps', {
      done: true,
      data: {
        enabledAppIds: enabled,
        coreAppIds: listCoreReleasedApps().map((app) => app.id),
      },
    });
  },
};

/** Reset step selection cache (tests). */
export function resetAppsStepState(): void {
  selectedOptional = new Set();
}
