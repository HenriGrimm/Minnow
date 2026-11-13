import {
  computePromptConfigTokenTotal,
  formatTokenEstimateLabel,
  SETTINGS_PROMPT_CONFIG_ESTIMATE_TOOLTIP,
  type OutboundPromptEstimate,
} from '../chat/prompts/token-estimate-core';
import { resolveOutboundPromptEstimate } from '../chat/prompts/token-estimate';
import { detectLocalServer } from '../tools/client';

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let lastEstimate: OutboundPromptEstimate | null = null;

function getHeaderEl(): HTMLElement | null {
  return document.getElementById('settingsPromptTokenEstimate');
}

function getBreakdownEl(): HTMLElement | null {
  return document.getElementById('settingsPromptTokenBreakdown');
}

function setComputing(): void {
  const header = getHeaderEl();
  const breakdown = getBreakdownEl();
  if (header) {
    header.textContent = '~…';
    header.setAttribute('aria-busy', 'true');
    header.title = SETTINGS_PROMPT_CONFIG_ESTIMATE_TOOLTIP;
  }
  if (breakdown) {
    breakdown.textContent = 'Computing estimate…';
    breakdown.setAttribute('aria-busy', 'true');
  }
}

function formatBreakdownLine(est: OutboundPromptEstimate): string {
  const parts = [
    `System ~${est.composedSystem.toLocaleString()}`,
    `Tools ~${est.tools.toLocaleString()}`,
    `Rules ~${est.userRules.toLocaleString()}`,
  ];
  return parts.join(' · ');
}

function paintEstimate(est: OutboundPromptEstimate): void {
  const header = getHeaderEl();
  const breakdown = getBreakdownEl();
  if (header) {
    header.textContent = formatTokenEstimateLabel(computePromptConfigTokenTotal(est));
    header.removeAttribute('aria-busy');
    header.title = SETTINGS_PROMPT_CONFIG_ESTIMATE_TOOLTIP;
  }
  if (breakdown) {
    breakdown.textContent = formatBreakdownLine(est);
    breakdown.removeAttribute('aria-busy');
  }
}

function paintError(): void {
  const header = getHeaderEl();
  const breakdown = getBreakdownEl();
  if (header) {
    header.textContent = '—';
    header.removeAttribute('aria-busy');
    header.title = 'Could not estimate prompt size.';
  }
  if (breakdown) {
    breakdown.textContent = 'Could not estimate';
    breakdown.removeAttribute('aria-busy');
  }
}

async function runEstimate(): Promise<void> {
  setComputing();
  try {
    const est = await resolveOutboundPromptEstimate();
    lastEstimate = est;
    paintEstimate(est);
  } catch {
    paintError();
  }
}

/** Recompute estimate immediately (settings open / section change). */
export function refreshPromptTokenEstimate(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  inFlight = runEstimate().finally(() => {
    inFlight = null;
  });
}

/** Debounced refresh after rapid prompting toggles (300 ms). */
export function schedulePromptTokenEstimateRefresh(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    refreshPromptTokenEstimate();
  }, 300);
}

let visibilityBound = false;

/** Call once when settings page initializes. */
export function initSettingsPromptEstimate(): void {
  if (visibilityBound) return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const root = document.getElementById('settingsView');
    if (root?.classList.contains('is-open')) {
      void detectLocalServer();
      refreshPromptTokenEstimate();
    }
  });
}

/** Latest successful estimate (for tests / debug). */
export function getLastPromptTokenEstimate(): OutboundPromptEstimate | null {
  return lastEstimate;
}
