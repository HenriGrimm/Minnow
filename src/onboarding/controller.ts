/**
 * First-run setup dialog and persisted provider navigation.
 */

import { isServerStorageMode } from '../config/storage-mode';
import { getLocalServerAvailable } from '../tools/client';
import { isWorkspaceFolderPickerOpen } from '../ui/workspace-folder-picker';
import { focusableWithin, isolateModalBackground, markOverlayRoot, trapTabKey, unmarkOverlayRoot } from '../ui/components/internal';
import { MINNOW_GLYPH_HEADER_HTML } from '../ui/minnow-glyph';
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
import type { OnboardingContext, OnboardingStepActions } from './types';
import { el } from './ui-helpers';

let rootEl: HTMLElement | null = null;
let dialogEl: HTMLElement | null = null;
let contentEl: HTMLElement | null = null;
let stepCleanup: (() => void) | null = null;
let ctx: OnboardingContext | null = null;
let stepIndex = 0;
let applicableSteps = ONBOARDING_STEPS;
let primaryBtn: HTMLButtonElement | null = null;
let backBtn: HTMLButtonElement | null = null;
let skipBtn: HTMLButtonElement | null = null;
let restoreBtn: HTMLButtonElement | null = null;
let errorEl: HTMLElement | null = null;
let retryBtn: HTMLButtonElement | null = null;
let pendingRetry: (() => Promise<void>) | null = null;
let navigating = false;
let restoring = false;
let mounting: Promise<void> | null = null;
let renewalTimer: ReturnType<typeof setInterval> | null = null;
let renderGeneration = 0;
let returnFocus: HTMLElement | null = null;
let releaseBackground: (() => void) | null = null;

export async function mountOnboarding(options?: { force?: boolean }): Promise<void> {
  if (mounting) return mounting;
  mounting = mountOverlay(Boolean(options?.force));
  try { await mounting; } finally { mounting = null; }
}

async function mountOverlay(force: boolean): Promise<void> {
  if (rootEl) return;

  let state = await loadOnboardingState();
  if (!force) {
    state = await migrateExistingUsersIfNeeded(state);
    if (state.completedAt) return;
  }
  const claim = await tryClaimOnboardingOverlay(state, force);
  if (!claim.claimed) {
    if (force) throw new Error('Setup is already open in another window.');
    return;
  }

  ctx = buildOnboardingContext(claim.state, {
    serverAvailable: getLocalServerAvailable(),
    configServerAvailable: isServerStorageMode(),
  });
  applicableSteps = getApplicableSteps(ctx);
  stepIndex = resolveStepIndex(applicableSteps, ctx);
  warmProviderProbes();

  rootEl = el('div', 'mn-onboarding');
  dialogEl = el('section', 'mn-onboarding__dialog');
  dialogEl.setAttribute('role', 'dialog');
  dialogEl.setAttribute('aria-modal', 'true');
  dialogEl.setAttribute('aria-labelledby', 'mn-onboarding-label');
  dialogEl.tabIndex = -1;

  const header = el('header', 'mn-onboarding__header');
  const glyph = el('span', 'mn-onboarding__glyph');
  glyph.setAttribute('aria-hidden', 'true');
  glyph.innerHTML = MINNOW_GLYPH_HEADER_HTML;
  const label = el('span', undefined, 'Minnow setup');
  label.id = 'mn-onboarding-label';
  header.append(glyph, label);
  contentEl = el('div', 'mn-onboarding-step');

  backBtn = button('mn-onboarding-back-btn', 'Back', () => goBack());
  skipBtn = button('mn-onboarding-skip-btn', 'Set up later', () => void runNavigation(finish));
  restoreBtn = button('mn-onboarding-back-btn', 'Restore from a backup', () => void runNavigation(openRestore));
  primaryBtn = button('mn-onboarding-primary-btn', 'Continue', () => void runNavigation(goNext));
  retryBtn = button('mn-onboarding-back-btn', 'Retry', () => {
    if (pendingRetry) void runNavigation(pendingRetry);
  });
  retryBtn.hidden = true;

  errorEl = el('p', 'mn-onboarding-save-error');
  errorEl.setAttribute('role', 'alert');
  errorEl.hidden = true;
  const actions = el('div', 'mn-onboarding__actions');
  actions.append(backBtn, restoreBtn, retryBtn, skipBtn, primaryBtn);
  const footer = el('footer', 'mn-onboarding__footer');
  footer.append(errorEl, actions);

  dialogEl.append(header, contentEl, footer);
  rootEl.append(dialogEl);
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.append(rootEl);
  releaseBackground = isolateModalBackground(rootEl);
  markOverlayRoot(rootEl, 'dialog');

  renewalTimer = setInterval(() => {
    void renewOnboardingOverlayClaim().catch((error) => showError(error, renewOnboardingOverlayClaim));
  }, 10_000);
  document.addEventListener('keydown', onKeyDown);
  renderCurrentStep();
}

function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function finish(): Promise<void> {
  return unmountOnboarding(true);
}

/** Tear down the overlay and release its second-window claim. */
export async function unmountOnboarding(complete = false): Promise<void> {
  if (!rootEl || !ctx) return;
  if (complete) ctx.state = await markOnboardingComplete(ctx.state);
  ctx.state = await releaseOnboardingOverlayClaim(ctx.state);
  if (renewalTimer) clearInterval(renewalTimer);
  renewalTimer = null;
  stepCleanup?.();
  stepCleanup = null;
  renderGeneration += 1;
  unmarkOverlayRoot(rootEl);
  rootEl.remove();
  releaseBackground?.();
  releaseBackground = null;
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
  document.removeEventListener('keydown', onKeyDown);

  rootEl = dialogEl = contentEl = errorEl = null;
  backBtn = restoreBtn = skipBtn = primaryBtn = retryBtn = null;
  pendingRetry = null;
  restoring = false;
  ctx = null;
}

function onKeyDown(event: KeyboardEvent): void {
  if (!dialogEl || event.defaultPrevented || isWorkspaceFolderPickerOpen()) return;
  const active = document.activeElement;
  const activeModal = active?.closest('[aria-modal="true"]');
  if (activeModal && activeModal !== dialogEl && !dialogEl.contains(activeModal)) return;
  if (event.key === 'Tab') {
    if (event.shiftKey && active === contentEl?.querySelector('h2')) {
      event.preventDefault();
      (focusableWithin(dialogEl).at(-1) ?? dialogEl).focus();
    } else {
      trapTabKey(dialogEl, event);
    }
  }
  if (event.key === 'Escape' && !restoring) {
    event.preventDefault();
    void runNavigation(finish);
  }
}

function makeActions(): OnboardingStepActions {
  const generation = renderGeneration;
  const isCurrent = () => Boolean(rootEl) && renderGeneration === generation;
  return {
    next: () => { if (isCurrent()) void runNavigation(goNext); },
    back: () => { if (isCurrent()) goBack(); },
    skip: () => { if (isCurrent()) void runNavigation(finish); },
    patchContext: (patch) => {
      if (!ctx || !isCurrent() || (stepIndex === 0 && navigating)) return;
      Object.assign(ctx, patch);
      applicableSteps = getApplicableSteps(ctx);
    },
    setPrimaryEnabled: (enabled) => {
      if (primaryBtn && isCurrent()) primaryBtn.disabled = !enabled;
    },
    setPrimaryLabel: (label) => {
      if (!primaryBtn || !isCurrent()) return;
      const lastStep = stepIndex === applicableSteps.length - 1;
      primaryBtn.textContent = lastStep && label === 'Continue' ? 'Done' : label;
      primaryBtn.hidden = stepIndex === 0 || label === 'Skip for now';
    },
    stepIndex,
    totalSteps: applicableSteps.length,
  };
}

function renderCurrentStep(): void {
  if (!ctx || !contentEl) return;
  renderGeneration += 1;
  stepCleanup?.();
  restoring = false;

  const step = applicableSteps[stepIndex];
  if (backBtn) backBtn.hidden = stepIndex === 0;
  if (restoreBtn) restoreBtn.hidden = stepIndex !== 0 || !ctx.configServerAvailable;
  if (skipBtn) skipBtn.hidden = false;
  if (primaryBtn) primaryBtn.hidden = stepIndex === 0;
  const cleanup = step.render(contentEl, ctx, makeActions());
  stepCleanup = typeof cleanup === 'function' ? cleanup : null;
  focusStep();
}

function focusStep(): void {
  if (!contentEl) return;
  contentEl.scrollTop = 0;
  const heading = contentEl.querySelector('h2');
  if (heading) heading.tabIndex = -1;
  (heading ?? dialogEl)?.focus({ preventScroll: true });
}

async function goNext(): Promise<void> {
  if (!ctx) return;
  const step = applicableSteps[stepIndex];
  await step.commit(ctx);
  if (stepIndex === applicableSteps.length - 1) {
    await finish();
    return;
  }
  await saveOnboardingState(ctx.state);
  stepIndex += 1;
  renderCurrentStep();
}

function goBack(): void {
  if (navigating) return;
  clearError();
  if (!restoring && stepIndex > 0) stepIndex -= 1;
  renderCurrentStep();
}

async function openRestore(): Promise<void> {
  const generation = renderGeneration;
  const [{ fetchBackupStatus }, { mountRestorePanel }] = await Promise.all([
    import('../backup/client'),
    import('../ui/backup-restore-panel'),
  ]);
  const status = await fetchBackupStatus();
  if (!contentEl || renderGeneration !== generation) return;
  restoring = true;
  renderGeneration += 1;
  stepCleanup?.();
  stepCleanup = null;

  const heading = el('h2', 'mn-onboarding-step-title', 'Restore from a backup');
  const mount = el('div');
  contentEl.replaceChildren(heading, mount);
  if (backBtn) backBtn.hidden = true;
  if (skipBtn) skipBtn.hidden = true;
  if (restoreBtn) restoreBtn.hidden = true;
  if (primaryBtn) primaryBtn.hidden = true;
  const panel = mountRestorePanel(mount, {
    initialDir: status.settings.lastDestDir || status.defaultDir,
    canRestartInPlace: status.packaged,
    elevated: true,
    onClose: goBack,
  });
  stepCleanup = () => panel.destroy();
  focusStep();
}

export async function rerunOnboardingFromSettings(): Promise<void> {
  await mountOnboarding({ force: true });
}

function clearError(): void {
  pendingRetry = null;
  if (errorEl) errorEl.hidden = true;
  if (retryBtn) retryBtn.hidden = true;
}

function showError(error: unknown, retry: () => Promise<void>): void {
  pendingRetry = retry;
  if (errorEl) {
    errorEl.textContent = error instanceof Error ? error.message : String(error);
    errorEl.hidden = false;
  }
  if (retryBtn) retryBtn.hidden = false;
}

async function runNavigation(action: () => Promise<void>): Promise<void> {
  if (navigating) return;
  navigating = true;
  clearError();
  try { await action(); }
  catch (error) { showError(error, action); }
  finally { navigating = false; }
}

export function isOnboardingMounted(): boolean {
  return Boolean(rootEl);
}
