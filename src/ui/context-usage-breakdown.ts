import { escapeHtml } from '../issues/markdown-inline';
import { iconHtml } from './icon';
import { showToast } from './toast';
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
const boundProfilePanels = new WeakSet<HTMLElement>();
let panelHome: { parent: Node; next: ChildNode | null } | null = null;

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
      <span class="context-usage-row__label">${escapeHtml(section.label)}</span>
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
  const limit = budget.limit;
  const fill = limit ? Math.min(1, budget.used / limit) : 0;
  const mark = limit && budget.compressAtTokens != null
    ? `<div class="context-usage-breakdown__gauge-mark" style="--mark-scale: ${Math.min(1, budget.compressAtTokens / limit)}"></div>` : '';
  const compaction = budget.compressAtTokens != null
    ? `Auto-compact at <strong>${formatTokens(budget.compressAtTokens)}</strong>`
    : 'Automatic compaction unavailable';
  return `<section class="context-usage-breakdown__summary${warn ? ' is-warn' : ''}" aria-label="Current context usage" title="${budget.isEstimate ? 'Context size uses character-based token estimates.' : 'Context size uses provider-reported context or the latest request, plus pending input.'} Section counts are estimates.">
    <div class="context-usage-breakdown__summary-stats">
      <div class="context-usage-breakdown__summary-stat">
        <span class="context-usage-breakdown__summary-value">${formatUsedTokens(budget)} <span>tokens used</span></span>
        <span class="context-usage-breakdown__summary-label">${limit != null ? `of ${formatTokens(limit)} available` : 'Context window unknown'}</span>
      </div>
      <span class="context-usage-breakdown__gauge-pct">${budget.percent != null ? `${budget.percent}%` : '—'}</span>
    </div>
    <div class="context-usage-breakdown__gauge-track" aria-hidden="true">
      <div class="context-usage-breakdown__gauge-fill" style="--fill-scale: ${fill}"></div>${mark}
    </div>
    <div class="context-usage-breakdown__summary-foot">
      <span>${budget.remaining != null ? `<strong>${budget.isEstimate ? '~' : ''}${formatTokens(budget.remaining)}</strong> free` : 'Compaction disabled'}</span>
      <span>${compaction}</span>
    </div>
  </section>`;
}

function renderProfileTabs(active: PromptProfileName): string {
  const buttons = PROFILE_TABS.map(
    (tab) =>
      `<button type="button" class="context-usage-breakdown__profile-tab${
        active === tab.id ? ' is-active' : ''
      }" data-context-profile="${tab.id}" aria-pressed="${active === tab.id}" title="${tab.id === 'full' ? 'Complete system instructions' : tab.id === 'lite' ? 'Shorter system instructions' : 'Your custom system instructions'}">${tab.label}</button>`,
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
    el.setAttribute('aria-pressed', String(el.dataset.contextProfile === profile));
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

/** Compact now: the same manual checkpoint `/compact` writes (no completion call). */
async function handleCompactNow(button: HTMLButtonElement): Promise<void> {
  // Loaded on click: the panel renders in places that never load the transcript.
  const [{ isChatStreaming }, { getActiveChat, scheduleSaveSessions }, { renderChatFromHistory }, { setStatus }] =
    await Promise.all([
      import('../chat/streaming-state'),
      import('../state/sessions'),
      import('./messages'),
      import('./status'),
    ]);
  const chat = getActiveChat();
  if (isChatStreaming(chat.id)) {
    setStatus('err', 'Wait for the current reply to finish');
    return;
  }
  button.disabled = true;
  try {
    const { compactChatHistory } = await import('../chat/context/compact-command');
    const modelId =
      chat.modelId?.trim() ||
      '';
    const result = compactChatHistory(chat, { modelId });
    if (!result.ok) {
      setStatus('err', result.reason);
      return;
    }
    scheduleSaveSessions();
    renderChatFromHistory(chat);
    showToast(result.status);
    const { refreshContextUsageRing } = await import('./context-usage-ring');
    refreshContextUsageRing();
  } finally {
    button.disabled = false;
  }
}

function handleProfileTabClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.closest('[data-context-action="close"]')) {
    const ring = openSurface && getContextUsageRingButton(openSurface);
    closeContextUsageBreakdown();
    ring?.focus();
    return;
  }
  const action = target.closest('[data-context-action="compact"]') as HTMLButtonElement | null;
  if (action) {
    event.stopPropagation();
    void handleCompactNow(action);
    return;
  }
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
    if (!panel || boundProfilePanels.has(panel)) continue;
    panel.addEventListener('click', handleProfileTabClick);
    boundProfilePanels.add(panel);
  }
}

function sectionVisible(section: ContextUsageSection): boolean {
  if (section.tokens > 0) return true;
  return section.key === 'codeMap' || section.key === 'contextDocuments';
}

function renderPanelBody(budget: ContextBudget): string {
  const visibleSections = budget.breakdown.filter(sectionVisible);
  const scaleMax = maxSectionTokens(visibleSections);
  const rows = visibleSections.map(section => renderSectionRow(section, budget.used, scaleMax)).join('');
  const session = budget.sessionUsage;
  const count = (value: number | null | undefined) => value == null ? '—' : formatTokens(value);
  const usage = budget.lastTurnTotalTokens != null || budget.lastTurnPromptTokens != null || budget.lastTurnCompletionTokens != null || session;
  const usageTable = usage ? `<table class="context-usage-breakdown__usage-table">
      <caption>Token usage</caption>
      <thead><tr><td></td><th scope="col">Last request</th><th scope="col">Session</th></tr></thead>
      <tbody>
        <tr><th scope="row">Input</th><td>${count(budget.lastTurnPromptTokens)}</td><td>${count(session?.promptTokens)}</td></tr>
        <tr><th scope="row">Output</th><td>${count(budget.lastTurnCompletionTokens)}</td><td>${count(session?.completionTokens)}</td></tr>
        <tr class="context-usage-breakdown__usage-total"><th scope="row">Total</th><td>${count(budget.lastTurnTotalTokens)}</td><td>${count(session?.totalTokens)}</td></tr>
      </tbody>
    </table>
    <p class="context-usage-breakdown__usage-note">${session ? `${formatTokens(session.completionCount)} recorded generations this session. ` : ''}Session totals include repeated history.${budget.lastTurnPromptTokens == null && budget.lastTurnCompletionTokens == null && budget.lastTurnTotalTokens == null ? ' Individual request counts are unavailable.' : ''}</p>`
    : '<h4 class="context-usage-breakdown__sections-title">Token usage</h4><p class="context-usage-breakdown__usage-note">Usage appears after your first reply.</p>';
  return `<header class="context-usage-breakdown__header">
      <div class="context-usage-breakdown__headline">
        <h3 class="context-usage-breakdown__title">Context</h3>
        <p class="context-usage-breakdown__model">${escapeHtml(budget.modelDisplayName)}</p>
      </div>
      <button type="button" class="context-usage-breakdown__close" data-context-action="close" aria-label="Close context details">${iconHtml('close', { size: 14 })}</button>
    </header>
    ${renderSummary(budget)}
    <div class="context-usage-breakdown__body">
      <section class="context-usage-breakdown__allocation">
        <h4 class="context-usage-breakdown__sections-title">In this context <span>estimated tokens</span></h4>
        ${rows ? `<div class="context-usage-breakdown__sections" role="list">${rows}</div>` : '<p class="context-usage-breakdown__usage-note">No context allocated yet.</p>'}
      </section>
      <section class="context-usage-breakdown__details">
        ${usageTable}
        <div class="context-usage-breakdown__profile">
          <h4 class="context-usage-breakdown__sections-title">System prompt</h4>
          ${renderProfileTabs(getPromptMetaSettingsSync().activePromptProfile)}
        </div>
      </section>
    </div>
    <footer class="context-usage-breakdown__actions">
      <p class="context-usage-breakdown__action-hint${budget.willCompress ? ' is-warn' : ''}">${budget.willCompress ? 'Older turns will be summarized on the next send.' : 'Compact older turns into a summary to free up space.'}</p>
      <button type="button" class="context-usage-breakdown__action" data-context-action="compact" title="Summarize older turns. The full conversation is kept.">Compact now</button>
    </footer>`;
}

function positionContextPanel(): void {
  if (!openSurface) return;
  const panel = getContextUsageBreakdownPanel(openSurface);
  const ring = getContextUsageRingButton(openSurface);
  if (!panel || !ring) return;
  const viewport = window.visualViewport;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  const offsetLeft = viewport?.offsetLeft ?? 0;
  const offsetTop = viewport?.offsetTop ?? 0;
  panel.classList.toggle('context-usage-breakdown--dense', height < 620);
  const rect = ring.getBoundingClientRect();
  const bounds = panel.getBoundingClientRect();
  const left = Math.max(offsetLeft + 8, Math.min(rect.right - bounds.width, offsetLeft + width - bounds.width - 8));
  const above = rect.top - bounds.height - 10;
  const top = above >= offsetTop + 8 ? above : Math.max(offsetTop + 8, Math.min(rect.bottom + 10, offsetTop + height - bounds.height - 8));
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}

function onPanelKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  const ring = openSurface && getContextUsageRingButton(openSurface);
  closeContextUsageBreakdown();
  ring?.focus();
}

function panelLayoutListeners(bind: boolean): void {
  const method = bind ? 'addEventListener' : 'removeEventListener';
  window[method]('resize', positionContextPanel);
  window.visualViewport?.[method]('resize', positionContextPanel);
  window.visualViewport?.[method]('scroll', positionContextPanel);
  if (bind) document.addEventListener('keydown', onPanelKeyDown);
  else document.removeEventListener('keydown', onPanelKeyDown);
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
  panel?.classList.add('hidden');
  if (panel && panelHome?.parent.isConnected) {
    const next = panelHome.next?.parentNode === panelHome.parent ? panelHome.next : null;
    panelHome.parent.insertBefore(panel, next);
  }
  panelHome = null;
  panelLayoutListeners(false);
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

  bindContextUsageProfileTabs();
  if (panel.parentNode) panelHome = { parent: panel.parentNode, next: panel.nextSibling };
  document.body.append(panel);
  panel.innerHTML = renderPanelBody(budget);
  panel.classList.remove('hidden');
  panelOpen = true;
  openSurface = surface;
  ring.setAttribute('aria-expanded', 'true');
  panel.querySelector<HTMLButtonElement>('[data-context-action="close"]')?.focus({ preventScroll: true });
  panelLayoutListeners(true);
  positionContextPanel();
}

/** Repaint open panel after budget refresh. */
export function syncContextUsageBreakdownIfOpen(budget: ContextBudget): void {
  if (!panelOpen || !openSurface) return;
  const panel = getContextUsageBreakdownPanel(openSurface);
  if (!panel) return;
  const focused = document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)
    ? document.activeElement.dataset.contextProfile ?? document.activeElement.dataset.contextAction : undefined;
  panel.innerHTML = renderPanelBody(budget);
  if (focused) panel.querySelector<HTMLElement>(`[data-context-profile="${focused}"], [data-context-action="${focused}"]`)?.focus({ preventScroll: true });
  positionContextPanel();
}
