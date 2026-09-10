import type { ContextBudget, ContextUsageSection } from '../chat/context-usage';
import {
  getPromptMetaSettingsSync,
  savePromptMetaSettings,
  type PromptProfileName,
} from '../config/prompt-meta';
import { formatStatCount } from '../usage/format-stat-count';
import {
  getActiveContextUsageSurface,
  getContextUsageBreakdownPanel,
  getContextUsageRingButton,
  listContextUsageSurfaces,
  type ContextUsageSurface,
} from './context-usage-surface';

let panelOpen = false;
let openSurface: ContextUsageSurface | null = null;
const boundProfilePanels = new Set<string>();

const PROFILE_TABS: { id: PromptProfileName; label: string }[] = [
  { id: 'full', label: 'Full' },
  { id: 'lite', label: 'Lite' },
  { id: 'custom', label: 'Custom' },
];

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  return formatStatCount(n).full || formatStatCount(n).display;
}

function formatUsedTokens(budget: ContextBudget): string {
  const count = formatTokens(budget.used);
  return budget.isEstimate ? `~${count}` : count;
}

function maxSectionTokens(sections: ContextUsageSection[]): number {
  let max = 1;
  for (const section of sections) {
    if (section.tokens > max) max = section.tokens;
  }
  return max;
}

/** Bar width: each section's share of total used tokens (fallback: largest section). */
function sectionFillScale(
  sectionTokens: number,
  usedTotal: number,
  scaleMax: number,
): number {
  const denom = usedTotal > 0 ? usedTotal : scaleMax;
  if (denom <= 0) return 0;
  return Math.min(1, sectionTokens / denom);
}

function renderSectionRow(
  section: ContextUsageSection,
  usedTotal: number,
  scaleMax: number,
): string {
  const fill = sectionFillScale(section.tokens, usedTotal, scaleMax);
  const inFlight = section.key === 'inFlight';
  return `
    <div class="context-usage-row" role="listitem" data-section="${section.key}">
      <span class="context-usage-row__label">${section.label}</span>
      <div class="context-usage-row__track" aria-hidden="true">
        <div class="context-usage-row__fill${inFlight ? ' is-in-flight' : ''}" style="--fill-scale: ${fill.toFixed(4)}"></div>
      </div>
      <span class="context-usage-row__count">~${formatTokens(section.tokens)}</span>
    </div>`;
}

/** Same warn rule as the ring: approaching the window, or past the trim ceiling. */
function isWarn(budget: ContextBudget): boolean {
  return budget.willCompress || (budget.percent != null && budget.percent >= 85);
}

function renderSummary(budget: ContextBudget): string {
  const warn = isWarn(budget);
  const fillScale =
    budget.limit != null && budget.limit > 0
      ? Math.min(1, budget.used / budget.limit)
      : 0;

  if (budget.limit == null) {
    return `
    <div class="context-usage-breakdown__summary${warn ? ' is-warn' : ''}" role="group" aria-label="Context usage">
      <div class="context-usage-breakdown__summary-stats">
        <div class="context-usage-breakdown__summary-stat">
          <span class="context-usage-breakdown__summary-label">Used</span>
          <span class="context-usage-breakdown__summary-value">${formatUsedTokens(budget)}</span>
        </div>
      </div>
      <p class="context-usage-breakdown__limit-unknown">Context limit unknown — compression disabled.</p>
    </div>`;
  }

  const usedLabel = formatUsedTokens(budget);
  const remainingLabel =
    budget.remaining != null
      ? `${budget.isEstimate ? '~' : ''}${formatTokens(budget.remaining)} free`
      : null;
  const ariaLabel = [
    budget.percent != null ? `${budget.percent}% used` : null,
    `${usedLabel} of ${formatTokens(budget.limit)} tokens`,
    remainingLabel,
  ]
    .filter(Boolean)
    .join(', ');

  const remainingPrefix = budget.isEstimate ? '~' : '';
  const freeStat =
    budget.remaining != null
      ? `<div class="context-usage-breakdown__summary-stat context-usage-breakdown__summary-stat--end">
          <span class="context-usage-breakdown__summary-label">Free</span>
          <span class="context-usage-breakdown__summary-value">${remainingPrefix}${formatTokens(budget.remaining)}</span>
        </div>`
      : '';

  const compressMarkScale =
    budget.compressAtTokens != null && budget.limit > 0
      ? Math.min(1, budget.compressAtTokens / budget.limit)
      : null;
  const compressMark =
    compressMarkScale != null
      ? `<div class="context-usage-breakdown__gauge-mark" style="--mark-scale: ${compressMarkScale.toFixed(4)}"></div>`
      : '';

  const gaugePct =
    budget.percent != null
      ? `<span class="context-usage-breakdown__gauge-pct${warn ? ' is-warn' : ''}">${budget.percent}%</span>`
      : '';

  // The runner trims below the raw window, so say where that line sits — a ring
  // that reads 92% has already started dropping turns.
  const compressAtFoot =
    budget.compressAtTokens != null
      ? `<div class="context-usage-breakdown__summary-foot">
          <span class="context-usage-breakdown__summary-foot-label">${
            budget.willCompress ? 'Compressing above' : 'Compresses above'
          }</span>
          <span class="context-usage-breakdown__summary-foot-value${warn ? ' is-warn' : ''}">${formatTokens(
            budget.compressAtTokens,
          )}</span>
        </div>`
      : '';

  return `
    <div class="context-usage-breakdown__summary${warn ? ' is-warn' : ''}" role="group" aria-label="${ariaLabel}">
      <div class="context-usage-breakdown__summary-stats">
        <div class="context-usage-breakdown__summary-stat">
          <span class="context-usage-breakdown__summary-label">Used</span>
          <span class="context-usage-breakdown__summary-value">${formatUsedTokens(budget)}</span>
        </div>
        ${freeStat}
      </div>
      <div class="context-usage-breakdown__gauge" aria-hidden="true">
        <div class="context-usage-breakdown__gauge-track">
          <div class="context-usage-breakdown__gauge-fill${warn ? ' is-warn' : ''}" style="--fill-scale: ${fillScale.toFixed(4)}"></div>
          ${compressMark}
        </div>
        ${gaugePct}
      </div>
      <div class="context-usage-breakdown__summary-foot">
        <span class="context-usage-breakdown__summary-foot-label">Window</span>
        <span class="context-usage-breakdown__summary-foot-value">${formatTokens(budget.limit)}</span>
      </div>
      ${compressAtFoot}
    </div>`;
}

function renderProfileTabs(active: PromptProfileName): string {
  const buttons = PROFILE_TABS.map(
    (tab) =>
      `<button type="button" class="context-usage-breakdown__profile-tab${
        active === tab.id ? ' is-active' : ''
      }" data-context-profile="${tab.id}">${tab.label}</button>`,
  ).join('');
  return `<div class="context-usage-breakdown__profile-tabs" role="group" aria-label="Prompt profile">${buttons}</div>`;
}

/** Keep Settings → Prompts profile tabs in sync when switching from the breakdown. */
function syncSettingsProfileTabs(profile: PromptProfileName): void {
  document.querySelectorAll('[data-profile-tab]').forEach((tab) => {
    const el = tab as HTMLButtonElement;
    el.classList.toggle('is-active', el.dataset.profileTab === profile);
  });
}

function paintProfileTabStates(profile: PromptProfileName): void {
  document.querySelectorAll('[data-context-profile]').forEach((tab) => {
    const el = tab as HTMLButtonElement;
    el.classList.toggle('is-active', el.dataset.contextProfile === profile);
  });
}

async function handleProfileTabSelect(profile: PromptProfileName): Promise<void> {
  const current = getPromptMetaSettingsSync().activePromptProfile;
  if (profile === current) return;

  await savePromptMetaSettings({ activePromptProfile: profile });
  syncSettingsProfileTabs(profile);
  paintProfileTabStates(profile);

  const { refreshContextUsageRing } = await import('./context-usage-ring');
  refreshContextUsageRing();

  const { schedulePromptTokenEstimateRefresh } = await import('./settings-prompt-estimate');
  schedulePromptTokenEstimateRefresh();

  const settingsRoot = document.getElementById('settingsView');
  if (settingsRoot?.classList.contains('is-open')) {
    const { refreshSettingsSection } = await import('./settings-sections');
    await refreshSettingsSection('prompting');
  }
}

function handleProfileTabClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const tab = target.closest('[data-context-profile]') as HTMLButtonElement | null;
  if (!tab) return;
  event.stopPropagation();

  const profile = tab.dataset.contextProfile;
  if (profile !== 'full' && profile !== 'lite' && profile !== 'custom') return;
  void handleProfileTabSelect(profile);
}

/** Bind profile tab clicks on breakdown panels (idempotent per panel). */
export function bindContextUsageProfileTabs(): void {
  for (const surface of listContextUsageSurfaces()) {
    const panel = getContextUsageBreakdownPanel(surface);
    if (!panel || boundProfilePanels.has(surface.breakdownId)) continue;
    panel.addEventListener('click', handleProfileTabClick);
    boundProfilePanels.add(surface.breakdownId);
  }
}

function sectionVisible(section: ContextUsageSection): boolean {
  if (section.tokens > 0) return true;
  return section.key === 'codeMap' || section.key === 'contextDocuments';
}

function renderPanelBody(budget: ContextBudget): string {
  const activeProfile = getPromptMetaSettingsSync().activePromptProfile;
  const visibleSections = budget.breakdown.filter(sectionVisible);
  const scaleMax = maxSectionTokens(visibleSections.length > 0 ? visibleSections : budget.breakdown);
  const rows = visibleSections
    .map((section) => renderSectionRow(section, budget.used, scaleMax))
    .join('');
  const sectionsBlock =
    visibleSections.length > 0
      ? `<div class="context-usage-breakdown__sections" role="list">${rows}</div>`
      : `<p class="context-usage-breakdown__sections-empty">No context allocated yet.</p>`;
  const lastTurnParts: string[] = [];
  if (budget.lastTurnPromptTokens != null) {
    lastTurnParts.push(`${formatTokens(budget.lastTurnPromptTokens)} prompt`);
  }
  if (budget.lastTurnCompletionTokens != null) {
    lastTurnParts.push(`${formatTokens(budget.lastTurnCompletionTokens)} completion`);
  }
  if (budget.lastTurnTotalTokens != null) {
    lastTurnParts.push(`${formatTokens(budget.lastTurnTotalTokens)} total`);
  }
  const lastTurnLine =
    lastTurnParts.length > 0
      ? `<p class="context-usage-breakdown__api-turn">
          <span class="context-usage-breakdown__api-turn-label">Last round (API)</span>
          <span class="context-usage-breakdown__api-turn-value">${lastTurnParts.join(' · ')}</span>
        </p>`
      : '';
  const session = budget.sessionUsage;
  const sessionLine = session
    ? `<p class="context-usage-breakdown__api-turn">
        <span class="context-usage-breakdown__api-turn-label">Session usage · ${formatTokens(session.completionCount)} requests</span>
        <span class="context-usage-breakdown__api-turn-value">${formatTokens(session.totalTokens)} total · ${formatTokens(session.promptTokens)} input · ${formatTokens(session.completionTokens)} output</span>
      </p>`
    : '';
  const estimateNote = budget.isEstimate
    ? `<p class="context-usage-breakdown__note">Section sizes use characters ÷ 4. Token counts vary by model tokenizer.</p>`
    : `<p class="context-usage-breakdown__note">Context used is the last request’s prompt + reply, plus pending input. Section rows are scaled estimates.</p>`;
  const compressNote = budget.willCompress
    ? `<p class="context-usage-breakdown__note">Over the trim ceiling: the next send compresses older turns before it leaves.</p>`
    : '';

  return `
    <header class="context-usage-breakdown__header">
      <div class="context-usage-breakdown__headline">
        <h3 class="context-usage-breakdown__title">Context</h3>
        <p class="context-usage-breakdown__model">${budget.modelDisplayName}</p>
      </div>
      ${renderProfileTabs(activeProfile)}
    </header>
    ${renderSummary(budget)}
    ${lastTurnLine}
    ${sessionLine}
    <p class="context-usage-breakdown__note">Session usage adds up all recorded requests, including tool rounds and titles. History sent again counts again; cached input can have a different price.</p>
    <h4 class="context-usage-breakdown__sections-title">Breakdown</h4>
    ${sectionsBlock}
    ${compressNote}
    ${estimateNote}
  `;
}

/** Whether the breakdown panel is open. */
export function isContextUsageBreakdownOpen(): boolean {
  return panelOpen;
}

/** Close anchored breakdown panel. */
export function closeContextUsageBreakdown(): void {
  const surface = openSurface ?? getActiveContextUsageSurface();
  const panel = getContextUsageBreakdownPanel(surface);
  const ring = getContextUsageRingButton(surface);
  if (!panel || panel.classList.contains('hidden')) {
    panelOpen = false;
    openSurface = null;
    return;
  }
  panel.classList.add('hidden');
  panelOpen = false;
  openSurface = null;
  ring?.setAttribute('aria-expanded', 'false');
}

/** Open or toggle breakdown for the given budget snapshot. */
export function toggleContextUsageBreakdown(
  budget: ContextBudget,
  surface: ContextUsageSurface = getActiveContextUsageSurface(),
): void {
  const panel = getContextUsageBreakdownPanel(surface);
  const ring = getContextUsageRingButton(surface);
  if (!panel || !ring) return;

  if (panelOpen && openSurface?.breakdownId === surface.breakdownId) {
    closeContextUsageBreakdown();
    return;
  }

  if (panelOpen) closeContextUsageBreakdown();

  panel.innerHTML = renderPanelBody(budget);
  panel.classList.remove('hidden');
  panelOpen = true;
  openSurface = surface;
  ring.setAttribute('aria-expanded', 'true');
}

/** Repaint open panel after budget refresh. */
export function syncContextUsageBreakdownIfOpen(budget: ContextBudget): void {
  if (!panelOpen || !openSurface) return;
  const panel = getContextUsageBreakdownPanel(openSurface);
  if (!panel) return;
  panel.innerHTML = renderPanelBody(budget);
}
