/**
 * Onboarding overlay controller — mount, navigation, keyboard, persistence.
 */

import { isServerStorageMode } from '../config/storage-mode';
import { getLocalServerAvailable } from '../tools/client';
import { navigateToSettingsField } from '../ui/settings-page';
import { mountStepSidebar, type StepSidebarHandle } from './step-sidebar';
import { getApplicableSteps, resolveStepIndex, ONBOARDING_STEPS } from './steps/registry';
import { warmProviderProbes } from './steps/provider';
import {
  buildOnboardingContext,
  loadOnboardingState,
  markOnboardingComplete,
  migrateExistingUsersIfNeeded,
  releaseOnboardingOverlayClaim,
  renewOnboardingOverlayClaim,
  saveOnboardingState,
  tryClaimOnboardingOverlay,
} from './state';
import type { OnboardingContext, OnboardingStepActions, OnboardingStepId } from './types';

let mounted = false;
let rootEl: HTMLElement | null = null;
let contentEl: HTMLElement | null = null;
let sidebarHandle: StepSidebarHandle | null = null;
let stepCleanup: (() => void) | null = null;
let ctx: OnboardingContext | null = null;
let stepIndex = 0;
let applicableSteps = ONBOARDING_STEPS;
let primaryBtn: HTMLButtonElement | null = null;
let backBtn: HTMLButtonElement | null = null;
let skipBtn: HTMLButtonElement | null = null;
let errorEl: HTMLElement | null = null;
let retryBtn: HTMLButtonElement | null = null;
let pendingRetry: (() => Promise<void>) | null = null;
let navigating = false;
let mounting: Promise<void> | null = null;
let renewalTimer: ReturnType<typeof setInterval> | null = null;
let renderGeneration = 0;

// ── Mount ────────────────────────────────────────────────────────────────────

/** Whether first-run wizard should open on boot (does not claim overlay). */
export async function shouldShowOnboardingOnBoot(): Promise<boolean> {
  let state = await loadOnboardingState();
  state = await migrateExistingUsersIfNeeded(state);
  return !state.completedAt;
}

/** Open wizard (boot or Settings → Run setup again). */
export async function mountOnboarding(options?: { force?: boolean }): Promise<void> {
  if (mounting) return mounting;
  mounting = mountOverlay(options);
  try { await mounting; } finally { mounting = null; }
}

async function mountOverlay(options?: { force?: boolean }): Promise<void> {
  if (mounted) return;

  let state = await loadOnboardingState();
  if (!options?.force) {
    state = await migrateExistingUsersIfNeeded(state);
    if (state.completedAt) return;
  }
  const claim = await tryClaimOnboardingOverlay(state, Boolean(options?.force));
  if (!claim.claimed) {
    if (options?.force) throw new Error('Setup is already open in another window.');
    return;
  }
  state = claim.state;

  await warmProviderProbes();

  ctx = buildOnboardingContext(state, {
    serverAvailable: getLocalServerAvailable(),
    configServerAvailable: isServerStorageMode(),
  });

  applicableSteps = getApplicableSteps(ctx);
  stepIndex = resolveStepIndex(applicableSteps, state.lastStep);

  rootEl = document.createElement('div');
  rootEl.className = 'mn-onboarding';
  rootEl.setAttribute('role', 'dialog');
  rootEl.setAttribute('aria-modal', 'true');
  rootEl.setAttribute('aria-label', 'Minnow setup');

  const asideMount = document.createElement('aside');
  const main = document.createElement('div');
  main.className = 'mn-onboarding__main';

  const mobileProgressMount = document.createElement('div');

  contentEl = document.createElement('div');
  contentEl.className = 'mn-onboarding__content';

  const footer = document.createElement('footer');
  footer.className = 'mn-onboarding__footer';

  backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'mn-onboarding-back-btn';
  backBtn.textContent = 'Back';
  backBtn.addEventListener('click', () => goBack());

  skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'mn-onboarding-skip-btn';
  skipBtn.textContent = 'Set up later';
  skipBtn.addEventListener('click', () => void runNavigation(skipCurrent));

  primaryBtn = document.createElement('button');
  primaryBtn.type = 'button';
  primaryBtn.className = 'mn-onboarding-primary-btn';
  primaryBtn.textContent = 'Continue';
  primaryBtn.addEventListener('click', () => void runNavigation(goNext));

  errorEl = document.createElement('p');
  errorEl.className = 'mn-onboarding-save-error';
  errorEl.setAttribute('role', 'alert');
  errorEl.hidden = true;
  retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'mn-onboarding-back-btn';
  retryBtn.textContent = 'Retry';
  retryBtn.hidden = true;
  retryBtn.addEventListener('click', () => {
    if (pendingRetry) void runNavigation(pendingRetry);
  });

  const actions = document.createElement('div');
  actions.className = 'mn-onboarding__actions';
  actions.append(backBtn, skipBtn, retryBtn, primaryBtn);
  footer.append(errorEl, actions);

  main.append(mobileProgressMount, contentEl, footer);
  rootEl.append(asideMount, main);
  document.body.appendChild(rootEl);
  document.documentElement.classList.add('onboarding-active');

  sidebarHandle = mountStepSidebar(
    asideMount,
    mobileProgressMount,
    applicableSteps,
    applicableSteps[stepIndex]?.id ?? 'welcome',
  );

  mounted = true;
  renewalTimer = setInterval(() => {
    void renewOnboardingOverlayClaim().catch((error) => {
      showSaveError(error, renewOnboardingOverlayClaim);
    });
  }, 10_000);
  bindKeyboard();
  renderCurrentStep();

  rootEl.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;
    const key = target.closest('[data-settings-search-key]')?.getAttribute('data-settings-search-key');
    if (key) {
      void runNavigation(async () => {
        await unmountOnboarding(false);
        navigateToSettingsField(key);
      });
    }
  });
}

/** Tear down overlay and release second-window claim. */
export async function unmountOnboarding(complete = false): Promise<void> {
  if (!mounted || !ctx) return;
  if (complete) ctx.state = await markOnboardingComplete(ctx.state);
  ctx.state = await releaseOnboardingOverlayClaim(ctx.state);
  if (renewalTimer) clearInterval(renewalTimer);
  renewalTimer = null;
  stepCleanup?.();
  renderGeneration += 1;
  stepCleanup = null;
  sidebarHandle?.destroy();
  sidebarHandle = null;
  rootEl?.remove();
  rootEl = null;
  contentEl = null;
  mounted = false;
  document.documentElement.classList.remove('onboarding-active');
  unbindKeyboard();

  errorEl = null;
  retryBtn = null;
  pendingRetry = null;
  ctx = null;
}

function bindKeyboard(): void {
  document.addEventListener('keydown', onKeyDown);
}

function unbindKeyboard(): void {
  document.removeEventListener('keydown', onKeyDown);
}

function onKeyDown(ev: KeyboardEvent): void {
  if (!mounted || ev.defaultPrevented) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    void runNavigation(() => unmountOnboarding(false));
    return;
  }
  if (ev.key === 'Enter' && !ev.shiftKey && primaryBtn && !primaryBtn.disabled) {
    const target = ev.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select, [contenteditable="true"], [role="button"]')) return;
    ev.preventDefault();
    void runNavigation(goNext);
  }
}

// ── Steps ────────────────────────────────────────────────────────────────────

function refreshApplicableSteps(): void {
  if (!ctx) return;
  applicableSteps = getApplicableSteps(ctx);
  sidebarHandle?.setSteps(applicableSteps);
}

function makeActions(): OnboardingStepActions {
  const generation = renderGeneration;
  const isCurrent = () => mounted && renderGeneration === generation;
  return {
    next: () => { if (isCurrent()) void runNavigation(goNext); },
    back: () => { if (isCurrent()) goBack(); },
    skip: () => { if (isCurrent()) void runNavigation(skipCurrent); },
    patchContext: (patch) => {
      if (!ctx || !isCurrent()) return;
      Object.assign(ctx, patch);
      refreshApplicableSteps();
    },
    setPrimaryEnabled: (enabled) => {
      if (primaryBtn && isCurrent()) primaryBtn.disabled = !enabled;
    },
    setPrimaryLabel: (label) => {
      if (primaryBtn && isCurrent()) primaryBtn.textContent = label;
    },
    stepIndex,
    totalSteps: applicableSteps.length,
  };
}

function setWelcomeLayout(active: boolean): void {
  rootEl?.classList.toggle('is-welcome', active);
}

function animateStepEnter(): void {
  if (!contentEl) return;
  const reduced =
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return;

  contentEl.classList.remove('is-entering');
  void contentEl.offsetWidth;
  contentEl.classList.add('is-entering');
  const onEnd = () => {
    contentEl?.classList.remove('is-entering');
    contentEl?.removeEventListener('animationend', onEnd);
  };
  contentEl.addEventListener('animationend', onEnd);
}

function renderCurrentStep(): void {
  if (!ctx || !contentEl) return;
  renderGeneration += 1;
  stepCleanup?.();
  stepCleanup = null;

  const step = applicableSteps[stepIndex];
  if (!step) return;

  setWelcomeLayout(step.id === 'welcome');

  if (backBtn) backBtn.hidden = stepIndex === 0;
  if (skipBtn) skipBtn.hidden = !step.canSkip;

  const cleanup = step.render(contentEl, ctx, makeActions());
  if (typeof cleanup === 'function') stepCleanup = cleanup;

  sidebarHandle?.setActiveStep(step.id, stepIndex);
  contentEl.scrollTop = 0;
  const heading = contentEl.querySelector<HTMLElement>('h1, h2');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  animateStepEnter();
}

async function goNext(): Promise<void> {
  if (!ctx || !contentEl) return;
  const step = applicableSteps[stepIndex];
  if (!step) return;

  await step.commit(ctx);
  await saveOnboardingState(ctx.state);

  if (step.id === 'extras') {
    ctx.searxngSkipped = Boolean(ctx.state.steps.extras?.data?.searxngSkipped);
  }

  if (step.id === 'apps' || step.id === 'provider-choice' || step.id === 'extras') {
    refreshApplicableSteps();
  }

  if (step.id === 'done') {
    await unmountOnboarding(true);
    return;
  }

  if (stepIndex < applicableSteps.length - 1) {
    stepIndex += 1;
    refreshApplicableSteps();
    renderCurrentStep();
  } else {
    await unmountOnboarding(true);
  }
}

function goBack(): void {
  if (navigating) return;
  clearSaveError();
  if (stepIndex <= 0) return;
  stepIndex -= 1;
  renderCurrentStep();
}

async function skipCurrent(): Promise<void> {
  if (!ctx) return;
  const step = applicableSteps[stepIndex];
  if (!step?.canSkip) return;

  if (step.id === 'welcome') {
    await unmountOnboarding(true);
    return;
  }

  if (step.id === 'extras') ctx.searxngSkipped = true;
  if (step.id === 'provider-choice') {
    ctx.providerPath = null;
    ctx.providerId = null;
    ctx.modelId = null;
  }

  ctx.state = {
    ...ctx.state,
    lastStep: step.id,
    steps: {
      ...ctx.state.steps,
      [step.id]: {
        ...(ctx.state.steps[step.id] ?? {}), done: false, skipped: true,
        data: step.id === 'extras' ? { searxngSkipped: true }
          : step.id === 'provider-choice' ? { path: null } : ctx.state.steps[step.id]?.data,
      },
    },
  };
  await saveOnboardingState(ctx.state);

  refreshApplicableSteps();

  if (stepIndex < applicableSteps.length - 1) {
    stepIndex += 1;
    refreshApplicableSteps();
    renderCurrentStep();
  } else {
    await unmountOnboarding(true);
  }
}

// ── Settings ─────────────────────────────────────────────────────────────────

/** Re-run entry from Settings. */
export async function rerunOnboardingFromSettings(): Promise<void> {
  await mountOnboarding({ force: true });
}

function clearSaveError(): void {
  pendingRetry = null;
  if (errorEl) errorEl.hidden = true;
  if (retryBtn) retryBtn.hidden = true;
}

function showSaveError(error: unknown, retry: () => Promise<void>): void {
  pendingRetry = retry;
  if (errorEl) {
    errorEl.textContent = `Setup could not be saved. ${error instanceof Error ? error.message : String(error)} Your choices are still here.`;
    errorEl.hidden = false;
  }
  if (retryBtn) retryBtn.hidden = false;
}

async function runNavigation(action: () => Promise<void>): Promise<void> {
  if (navigating) return;
  navigating = true;
  clearSaveError();
  try { await action(); }
  catch (error) { showSaveError(error, action); }
  finally { navigating = false; }
}

export function isOnboardingMounted(): boolean {
  return mounted;
}
