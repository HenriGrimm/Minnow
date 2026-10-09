/**
 * Shared DOM helpers for onboarding step screens.
 */

import { formatStepPosition } from './phases';
import type { OnboardingStep } from './types';

/** Step position header shown above step content (non-welcome steps). */
export function renderStepHeader(
  container: HTMLElement,
  step: OnboardingStep,
  stepIndex: number,
  totalSteps: number,
): void {
  const header = el('header', 'mn-onboarding-step-header');
  header.appendChild(
    el('span', 'mn-onboarding-step-eyebrow', formatStepPosition(stepIndex, totalSteps)),
  );
  header.appendChild(el('h2', 'mn-onboarding-step-title', step.title));
  container.appendChild(header);
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Choice card for single-select onboarding questions. */
export function createChoiceCard(options: {
  title: string;
  description: string;
  badge?: string;
  recommended?: boolean;
  selected?: boolean;
  onSelect: () => void;
  onHover?: () => void;
}): HTMLButtonElement {
  const card = el('button', 'mn-onboarding-choice');
  card.type = 'button';
  card.setAttribute('aria-pressed', String(Boolean(options.selected)));
  if (options.selected) card.classList.add('is-selected');
  if (options.recommended) card.classList.add('is-recommended');

  const head = el('div', 'mn-onboarding-choice__head');
  head.appendChild(el('span', 'mn-onboarding-choice__title', options.title));
  if (options.badge) {
    head.appendChild(el('span', 'mn-onboarding-choice__badge', options.badge));
  }
  card.appendChild(head);
  card.appendChild(el('p', 'mn-onboarding-choice__desc', options.description));

  if (options.recommended) {
    card.appendChild(el('span', 'mn-onboarding-choice__tag', 'Recommended'));
  }

  card.addEventListener('click', options.onSelect);
  if (options.onHover) {
    card.addEventListener('mouseenter', options.onHover);
    card.addEventListener('focus', options.onHover);
  }
  return card;
}

/** Status pill for reachability / install state. */
export function createStatusPill(kind: 'ok' | 'err' | 'pending', label: string): HTMLSpanElement {
  const pill = el('span', `mn-onboarding-status mn-onboarding-status--${kind}`, label);
  return pill;
}
