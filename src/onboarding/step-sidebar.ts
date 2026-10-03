/**
 * Left setup rail — brand, phase list, progress bar, and fish marker.
 */

import { formatStepPosition, getApplicablePhases, resolvePhaseIndex, type OnboardingPhase } from './phases';
import type { OnboardingStep, OnboardingStepId } from './types';

const BRAND_GLYPH_URL = '/logos/minnow-1024.png';
const FAVICON_URL = '/logos/favicon.ico';

export interface StepSidebarHandle {
  setActiveStep: (stepId: OnboardingStepId, stepIndex: number) => void;
  /** Replace the filtered step list when path-dependent steps become applicable. */
  setSteps: (steps: OnboardingStep[]) => void;
  destroy: () => void;
}

function prefersReducedMotion(): boolean {
  return (
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Mount the desktop sidebar and mobile progress strip. */
export function mountStepSidebar(
  asideMount: HTMLElement,
  mobileMount: HTMLElement,
  steps: OnboardingStep[],
  activeId: OnboardingStepId,
): StepSidebarHandle {
  let activeSteps = steps;
  let phases = getApplicablePhases(activeSteps);
  const reduced = prefersReducedMotion();

  asideMount.innerHTML = '';
  asideMount.className = 'mn-onboarding__aside';
  asideMount.setAttribute('aria-label', 'Setup progress');

  const brand = document.createElement('div');
  brand.className = 'mn-onboarding__brand';

  const glyph = document.createElement('img');
  glyph.className = 'mn-onboarding__brand-glyph';
  glyph.src = BRAND_GLYPH_URL;
  glyph.alt = '';
  glyph.width = 28;
  glyph.height = 28;

  const brandText = document.createElement('span');
  brandText.className = 'mn-onboarding__brand-name';
  brandText.textContent = 'Minnow setup';

  brand.append(glyph, brandText);
  asideMount.appendChild(brand);

  const phaseNav = document.createElement('nav');
  phaseNav.className = 'mn-onboarding__phases';
  phaseNav.setAttribute('aria-label', 'Setup phases');

  const phaseItems: HTMLElement[] = [];
  phases.forEach((phase, phaseIndex) => {
    const item = document.createElement('div');
    item.className = 'mn-onboarding__phase';
    item.dataset.phaseId = phase.id;

    const marker = document.createElement('span');
    marker.className = 'mn-onboarding__phase-marker';
    marker.setAttribute('aria-hidden', 'true');

    const copy = document.createElement('div');
    copy.className = 'mn-onboarding__phase-copy';

    const label = document.createElement('span');
    label.className = 'mn-onboarding__phase-label';
    label.textContent = phase.label;

    const hint = document.createElement('span');
    hint.className = 'mn-onboarding__phase-hint';
    hint.textContent = formatPhaseHint(phase, activeSteps);

    copy.append(label, hint);
    item.append(marker, copy);
    phaseNav.appendChild(item);
    phaseItems.push(item);

    if (phaseIndex < phases.length - 1) {
      const connector = document.createElement('div');
      connector.className = 'mn-onboarding__phase-connector';
      connector.setAttribute('aria-hidden', 'true');
      phaseNav.appendChild(connector);
    }
  });

  asideMount.appendChild(phaseNav);

  const progressBlock = document.createElement('div');
  progressBlock.className = 'mn-onboarding__progress-block';

  const progressTrack = document.createElement('div');
  progressTrack.className = 'mn-onboarding__progress-track';
  progressTrack.setAttribute('role', 'progressbar');
  progressTrack.setAttribute('aria-label', 'Setup progress');
  progressTrack.setAttribute('aria-valuemin', '0');
  progressTrack.setAttribute('aria-valuemax', '100');

  const progressFill = document.createElement('div');
  progressFill.className = 'mn-onboarding__progress-fill';
  progressTrack.appendChild(progressFill);

  const progressMeta = document.createElement('div');
  progressMeta.className = 'mn-onboarding__progress-meta';

  const progressLabel = document.createElement('span');
  progressLabel.className = 'mn-onboarding__progress-label';

  const fish = document.createElement('div');
  fish.className = 'mn-onboarding__progress-fish';
  fish.setAttribute('aria-hidden', 'true');

  const fishImg = document.createElement('img');
  fishImg.src = FAVICON_URL;
  fishImg.alt = '';
  fishImg.width = 18;
  fishImg.height = 18;
  fishImg.className = 'mn-onboarding__progress-fish-glyph';
  fish.appendChild(fishImg);

  progressMeta.append(progressLabel, fish);
  progressBlock.append(progressTrack, progressMeta);
  asideMount.appendChild(progressBlock);

  mobileMount.innerHTML = '';
  mobileMount.className = 'mn-onboarding__mobile-progress';

  const mobileTrack = progressTrack.cloneNode(true) as HTMLElement;
  const mobileFill = mobileTrack.querySelector('.mn-onboarding__progress-fill') as HTMLElement;
  const mobileLabel = document.createElement('span');
  mobileLabel.className = 'mn-onboarding__mobile-progress-label';
  mobileMount.append(mobileTrack, mobileLabel);

  let activeStepIndex = Math.max(0, activeSteps.findIndex((s) => s.id === activeId));

  function refreshPhaseHints(): void {
    phases.forEach((phase, phaseIndex) => {
      const hint = phaseItems[phaseIndex]?.querySelector('.mn-onboarding__phase-hint');
      if (hint) hint.textContent = formatPhaseHint(phase, activeSteps);
    });
  }

  function paint(stepId: OnboardingStepId, stepIndex: number): void {
    activeStepIndex = stepIndex;
    const phaseIndex = resolvePhaseIndex(phases, stepId);
    const pct =
      activeSteps.length <= 1 ? 0 : Math.round((stepIndex / (activeSteps.length - 1)) * 100);

    phaseItems.forEach((item, i) => {
      item.classList.toggle('is-active', i === phaseIndex);
      item.classList.toggle('is-done', i < phaseIndex);
    });

    progressFill.style.width = `${pct}%`;
    mobileFill.style.width = `${pct}%`;
    progressTrack.setAttribute('aria-valuenow', String(pct));
    mobileTrack.setAttribute('aria-valuenow', String(pct));

    const position = formatStepPosition(stepIndex, activeSteps.length);
    progressLabel.textContent = position;
    mobileLabel.textContent = position;

    if (!reduced) {
      fish.classList.remove('is-swimming');
      void fish.offsetWidth;
      fish.classList.add('is-swimming');
    }
  }

  paint(activeId, activeStepIndex);

  const onResize = () =>
    paint(activeSteps[activeStepIndex]?.id ?? activeId, activeStepIndex);
  window.addEventListener('resize', onResize);

  return {
    setActiveStep(stepId, stepIndex) {
      paint(stepId, stepIndex);
    },
    setSteps(nextSteps) {
      activeSteps = nextSteps;
      phases = getApplicablePhases(activeSteps);
      refreshPhaseHints();
      const stepId = activeSteps[activeStepIndex]?.id ?? activeId;
      paint(stepId, activeStepIndex);
    },
    destroy() {
      window.removeEventListener('resize', onResize);
      asideMount.innerHTML = '';
      mobileMount.innerHTML = '';
    },
  };
}

function formatPhaseHint(phase: OnboardingPhase, steps: OnboardingStep[]): string {
  const applicable = phase.stepIds.filter((id) => steps.some((s) => s.id === id));
  if (applicable.length <= 1) {
    const step = steps.find((s) => s.id === applicable[0]);
    return step?.title ?? '';
  }
  return `${applicable.length} steps`;
}
