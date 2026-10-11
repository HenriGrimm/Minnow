/**
 * S1 — Theme and accent: reuses Settings → Appearance theme pickers.
 */

import '../../styles/settings-page.css';
import '../../styles/settings-appearance.css';

import {
  getFollowSystem,
  getMode,
  getStoredFamily,
  getStoredTheme,
  setFollowSystem,
  setThemeFamily,
  setThemeMode,
  type ThemeMode,
} from '../../theme';
import { appendThemeControls } from '../../ui/settings-theme';
import { mountDesktopZoomControl } from '../../ui/desktop-zoom-control';
import { applyResolvedTheme } from '../../ui/theme';
import { el, renderStepHeader } from '../ui-helpers';
import type { OnboardingContext, OnboardingStep } from '../types';
import { recordStepProgress } from '../state-core';

/** Apply wizard context onto live theme prefs before mounting shared controls. */
function syncContextToAppearance(ctx: OnboardingContext): void {
  if (ctx.themeMode === 'system') {
    setFollowSystem(true);
  } else if (ctx.themeMode) {
    setFollowSystem(false);
    setThemeMode(ctx.themeMode);
  }

  if (ctx.themeFamily) {
    setThemeFamily(ctx.themeFamily);
  }

  applyResolvedTheme(getStoredTheme());
}

export const themeStep: OnboardingStep = {
  id: 'theme',
  title: 'Choose your look',
  canSkip: true,

  isApplicable() {
    return true;
  },

  render(container, ctx, actions) {
    container.innerHTML = '';
    container.className = 'mn-onboarding-step mn-onboarding-step--theme';

    syncContextToAppearance(ctx);

    renderStepHeader(container, themeStep, actions.stepIndex, actions.totalSteps);
    container.appendChild(
      el('p', 'mn-onboarding-step-desc', 'Appearance changes apply immediately.'),
    );

    const zoomMount = el('div', 'mn-onboarding-appearance-zoom');
    container.appendChild(zoomMount);
    const cleanupZoom = mountDesktopZoomControl(zoomMount);

    const themeMount = el('div', 'mn-onboarding-appearance-theme');
    appendThemeControls(themeMount, {
      onChange: (state) => {
        actions.patchContext({
          themeMode: state.followSystem ? 'system' : state.mode,
          themeFamily: state.family,
        });
      },
    });
    container.appendChild(themeMount);

    actions.setPrimaryLabel('Continue');
    actions.setPrimaryEnabled(true);
    return cleanupZoom;
  },

  commit(ctx) {
    applyResolvedTheme(getStoredTheme());

    const follow = getFollowSystem();
    const family = getStoredFamily();
    const mode: ThemeMode | 'system' = follow ? 'system' : getMode(getStoredTheme());

    ctx.state = recordStepProgress(ctx.state, 'theme', {
      done: true,
      data: {
        mode,
        family,
      },
    });
  },
};
