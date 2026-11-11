import { escapeHtml } from '../issues/markdown-inline';
import { iconHtml } from './icon';
import { markPreviewOccluder, unmarkPreviewOccluder } from './preview-occlusion';
import { showToast } from './toast';
import type { ContextBudget, ContextUsageSection } from '../chat/context-usage';
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
const boundPanels = new WeakSet<HTMLElement>();
let panelHome: { parent: Node; next: ChildNode | null } | null = null;

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  return formatStatCount(n).full || formatStatCount(n).display;
}

function formatUsedTokens(budget: ContextBudget): string {
  const count = formatTokens(budget.used);
  return budget.isEstimate ? `~${count}` : count;
}

function renderSectionRow(section: ContextUsageSection): string {
  return `
    <div class="context-usage-row" role="listitem" data-section="${section.key}">
      <span class="context-usage-row__label">${escapeHtml(section.label)}</span>
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
  return `<section class="context-usage-breakdown__summary${warn ? ' is-warn' : ''}" aria-label="Current context usage" title="${budget.isEstimate ? 'Estimated context usage' : 'Reported context usage plus pending input'}">
    <div class="context-usage-breakdown__summary-stats">
      <span><strong>${formatUsedTokens(budget)}</strong> ${limit != null ? `of ${formatTokens(limit)} tokens` : 'tokens used'}</span>
      <span class="context-usage-breakdown__gauge-pct">${budget.percent != null ? `${budget.percent}%` : 'Limit unknown'}</span>
    </div>
    ${limit ? `<div class="context-usage-breakdown__gauge-track" aria-hidden="true">
      <div class="context-usage-breakdown__gauge-fill" style="--fill-scale: ${fill}"></div>${mark}
    </div>` : ''}
  </section>`;
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

function handlePanelClick(event: Event): void {
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
}

/** Bind breakdown controls once per panel. */
export function bindContextUsageBreakdownControls(): void {
  for (const surface of listContextUsageSurfaces()) {
    const panel = getContextUsageBreakdownPanel(surface);
    if (!panel || boundPanels.has(panel)) continue;
    panel.addEventListener('click', handlePanelClick);
    // Native disclosure toggles do not bubble.
    panel.addEventListener('toggle', positionContextPanel, true);
    boundPanels.add(panel);
  }
}

function sectionVisible(section: ContextUsageSection): boolean {
  if (section.tokens > 0) return true;
  return section.key === 'codeMap' || section.key === 'contextDocuments';
}

function renderDetails(budget: ContextBudget): string {
  const rows = budget.breakdown.filter(sectionVisible).map(renderSectionRow).join('');
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
  return `<div class="context-usage-breakdown__details-content">
    ${rows ? `<section>
      <h4 class="context-usage-breakdown__sections-title">Context breakdown <span>Estimated tokens</span></h4>
      <div class="context-usage-breakdown__sections" role="list">${rows}</div>
    </section>` : ''}
    <section>${usageTable}</section>
  </div>`;
}

function renderPanelBody(budget: ContextBudget, detailsOpen = false): string {
  const compaction = budget.willCompress
    ? 'Auto-compacts on next send'
    : budget.compressAtTokens != null
      ? `Auto-compact at ${formatTokens(budget.compressAtTokens)}`
      : 'Auto-compaction unavailable';
  return `<header class="context-usage-breakdown__header">
      <div class="context-usage-breakdown__headline">
        <h3 class="context-usage-breakdown__title">Context</h3>
        <p class="context-usage-breakdown__model">${escapeHtml(budget.modelDisplayName)}</p>
      </div>
      <button type="button" class="context-usage-breakdown__close" data-context-action="close" aria-label="Close context details">${iconHtml('close', { size: 14 })}</button>
    </header>
    ${renderSummary(budget)}
    <div class="context-usage-breakdown__actions">
      <p class="context-usage-breakdown__action-hint${budget.willCompress ? ' is-warn' : ''}">${compaction}</p>
      <button type="button" class="context-usage-breakdown__action" data-context-action="compact" title="Summarize older turns. The full conversation is kept.">Compact now</button>
    </div>
    <details class="context-usage-breakdown__details"${detailsOpen ? ' open' : ''}>
      <summary data-context-action="details">Details</summary>
      ${renderDetails(budget)}
    </details>`;
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
  panel.style.maxHeight = `${height - 16}px`;
  panel.style.maxWidth = `${width - 16}px`;
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
  if (panel) {
    panel.classList.add('hidden');
    unmarkPreviewOccluder(panel);
  }
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

  bindContextUsageBreakdownControls();
  if (panel.parentNode) panelHome = { parent: panel.parentNode, next: panel.nextSibling };
  document.body.append(panel);
  panel.innerHTML = renderPanelBody(budget);
  panel.classList.remove('hidden');
  markPreviewOccluder(panel);
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
    ? document.activeElement.dataset.contextAction : undefined;
  const detailsOpen = panel.querySelector('details')?.open;
  const scrollTop = panel.scrollTop;
  panel.innerHTML = renderPanelBody(budget, detailsOpen);
  if (focused) panel.querySelector<HTMLElement>(`[data-context-action="${focused}"]`)?.focus({ preventScroll: true });
  positionContextPanel();
  panel.scrollTop = scrollTop;
}
