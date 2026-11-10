import { STATS_STRIP_OPEN_KEY } from '../constants';
import { notifyPluginContextChanged } from '../plugins/events';
import { resolveModelInfo } from '../api/models';
import { isChatStreaming } from '../chat/streaming-state';
import { getActiveChat, markChatDirty } from '../state/sessions';
import {
  buildLastStatsSnapshot,
  lastStatsHasMetrics,
  lastStatsNeedsHydration,
  lastStatsToStats,
  lastStatsToUsage,
  resolveLastTurnMetrics,
} from '../usage/chat-turn-metrics';
import { formatStatCount } from '../usage/format-stat-count';
import { formatUsd } from '../usage/token-ledger';
import type { Chat, ModelInfo, Stats, Usage } from '../types';

export { buildLastStatsSnapshot } from '../usage/chat-turn-metrics';

/** Whether the bottom metrics strip is visible (not fully collapsed). */
export function isStatsStripOpen(): boolean {
  const strip = document.getElementById('statsStrip');
  return strip ? !strip.classList.contains('is-collapsed') : false;
}

/** Show or hide the metrics strip and sync its disclosure. */
export function setStatsStripOpen(open: boolean): void {
  const strip = document.getElementById('statsStrip');
  const topBtn = document.getElementById('btnStats');
  if (!strip) return;

  const wasOpen = isStatsStripOpen();
  strip.classList.toggle('is-collapsed', !open);
  topBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');

  if (!open) {
    strip.classList.remove('is-expanded');
    const expandBtn = document.getElementById('statsExpandBtn');
    expandBtn?.setAttribute('aria-expanded', 'false');
    document.querySelector<HTMLDetailsElement>('#statsDetails')?.removeAttribute('open');
  }

  if (wasOpen !== open) {
    try {
      localStorage.setItem(STATS_STRIP_OPEN_KEY, open ? '1' : '0');
    } catch {
    }
  }
}

export function openStatsStrip(): void {
  setStatsStripOpen(true);
}

export function closeStatsStrip(): void {
  setStatsStripOpen(false);
}

export function toggleStatsStrip(): void {
  setStatsStripOpen(!isStatsStripOpen());
}

/** Wire the inference metrics disclosure and restore its preference. */
export function initStatsStrip(): void {
  let open = false;
  try {
    open = localStorage.getItem(STATS_STRIP_OPEN_KEY) === '1';
  } catch {
    open = false;
  }
  setStatsStripOpen(open);
  document.getElementById('btnStats')?.addEventListener('click', () => {
    toggleStatsStrip();
  });
}

/** Expand or collapse the detailed metrics panel inside an open strip. */
export function toggleStatsPanel(): void {
  const strip = document.getElementById('statsStrip')!;
  if (strip.classList.contains('is-collapsed')) {
    setStatsStripOpen(true);
  }
  const btn = document.getElementById('statsExpandBtn')!;
  const expanded = strip.classList.toggle('is-expanded');
  btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

/** Collapse expanded metrics when the file viewer split is active (narrow chat column). */
export function collapseStatsPanelForSplit(): void {
  const strip = document.getElementById('statsStrip');
  const btn = document.getElementById('statsExpandBtn');
  if (!strip) return;
  strip.classList.remove('is-expanded');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  updateStatsExpandPreview();
}

/** Reset stats expand state when the workspace split opens or closes. */
export function syncStatsStripLayoutForViewer(viewerOpen: boolean): void {
  if (viewerOpen) collapseStatsPanelForSplit();
}

export function updateStatsExpandPreview(): void {
  const tpsEl = document.getElementById('stripTPS');
  const totalEl = document.getElementById('stripTotal');
  if (!tpsEl || !totalEl) return;
  const metricValue = (el: HTMLElement) => el.dataset.metricValue ?? el.textContent?.trim() ?? '';
  const tps = metricValue(tpsEl);
  const total = metricValue(totalEl);
  const rate = tps && tps !== '—' ? `${tps} t/s` : '';
  const tokens = total && total !== '—' ? `${total} tokens` : '';
  const preview = document.getElementById('statsExpandPreview');
  if (preview) preview.textContent = [rate, tokens].filter(Boolean).join(' · ');

  const barPreview = document.getElementById('statusMetricPreview');
  if (barPreview) {
    barPreview.setAttribute('data-plugin-slot', 'chat.throughput');
    setNativeMetricText(barPreview, rate);
  }
  const tokenPreview = document.getElementById('statusMetricTokenPreview');
  if (tokenPreview) tokenPreview.textContent = rate && tokens ? ` · ${tokens}` : tokens;
}

export interface UpdateStripOptions {
  /** Override cost chip (e.g. board-wide rollup). */
  costUsd?: number | null;
  /** Board metrics own the shared strip while Boards is open. */
  board?: boolean;
  /** A partial response can report output without its input or a settled cost. */
  live?: boolean;
}

/** Preserve plugin contributions when the native rate changes. */
function setNativeMetricText(el: HTMLElement, value: string): void {
  const first = el.firstChild;
  if (first?.nodeType === Node.TEXT_NODE) {
    if (first.nodeValue !== value) first.nodeValue = value;
  } else if (value) {
    el.prepend(document.createTextNode(value));
  }
}

function latestTurnCost(snapshot: ReturnType<typeof buildLastStatsSnapshot>): number | null {
  if (snapshot.total_tokens == null) return null;
  try {
    const entries = getActiveChat().tokenLedger?.entries ?? [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry.source.kind !== 'main') continue;
      const measured = buildLastStatsSnapshot(undefined, entry.usage);
      return measured.total_tokens === snapshot.total_tokens &&
        (snapshot.prompt_tokens == null || measured.prompt_tokens === snapshot.prompt_tokens) &&
        (snapshot.completion_tokens == null || measured.completion_tokens === snapshot.completion_tokens)
        ? entry.costUsd : null;
    }
  } catch {
    // Catalog refresh can run before sessions hydrate.
  }
  return null;
}

const FINISH_LABELS = new Map([
  ['stop', 'Completed'],
  ['eos', 'End of sequence'],
  ['length', 'Token limit reached'],
  ['tool_calls', 'Tool call requested'],
  ['function_call', 'Function call requested'],
  ['content_filter', 'Content filter'],
  ['cancelled', 'Cancelled'],
  ['canceled', 'Cancelled'],
]);

const secondsFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });

function knownText(value?: string): string | null {
  const text = value?.trim();
  return text && !/^(?:unknown|n\/a|none|—|-)$/i.test(text) ? text : null;
}

/** Refresh composer metrics from the canonical turn snapshot. */
export function updateStrip(
  stats: Stats | undefined,
  usage: Usage | undefined,
  modelInfo: ModelInfo | undefined,
  options?: UpdateStripOptions,
): void {
  if (!options?.board) notifyPluginContextChanged();
  if (document.getElementById('mainColumn')?.classList.contains('main-column--orchestrator-boards') && !options?.board) return;
  const snapshot = buildLastStatsSnapshot(stats, usage);
  const s = lastStatsToStats(snapshot);
  const m = modelInfo || {};
  document.getElementById('stripTPS')?.setAttribute('data-plugin-slot', 'chat.throughput');

  function set(id: string, value: string | null, title?: string): boolean {
    const el = document.getElementById(id);
    if (!el) return false;
    const slot = id === 'stripTPS';
    if (slot || id === 'stripTotal') el.dataset.metricValue = value ?? '';
    if (slot) setNativeMetricText(el, value ?? '');
    else if (el.textContent !== (value ?? '')) el.textContent = value ?? '';
    el.closest('.stat-cell, .stats-details__field')?.toggleAttribute('hidden', value == null);
    if (title) el.title = title;
    else el.removeAttribute('title');
    return value != null;
  }

  /** Apply compact M/B (or comma) formatting with a full-number hover title. */
  function setCount(id: string, value: number | null | undefined, unit = ''): boolean {
    const formatted = formatStatCount(value);
    return formatted.full
      ? set(id, formatted.display + unit, formatted.full + unit)
      : set(id, null);
  }

  const seconds = (value?: number): string | null =>
    value == null ? null : `${secondsFormat.format(value)}\u00a0s`;
  const outputOnly = options?.live && snapshot.prompt_tokens == null &&
    snapshot.total_tokens === snapshot.completion_tokens;
  const cost = options?.costUsd !== undefined
    ? options.costUsd
    : options?.live ? null : latestTurnCost(snapshot);
  const costLabel = cost != null && Number.isFinite(cost) && cost >= 0
    ? cost === 0 ? '$0.00' : formatUsd(cost) : null;
  const hasSummary = [
    set('stripTPS', s.tokens_per_second?.toFixed(1) ?? null),
    set('stripTTFT', seconds(s.time_to_first_token)),
    set('stripGen', seconds(s.generation_time)),
    setCount('stripTotal', outputOnly ? null : snapshot.total_tokens),
    set('stripCost', costLabel),
  ].some(Boolean);
  const finish = knownText(s.stop_reason);
  const hasTurnDetails = [
    setCount('cntPrompt', snapshot.prompt_tokens),
    setCount('cntCompletion', snapshot.completion_tokens),
    set('iStop', finish ? FINISH_LABELS.get(finish.toLowerCase()) ?? finish.replace(/[_-]/g, ' ') : null, finish ?? undefined),
  ].some(Boolean);
  const hasModelDetails = [
    setCount('iCtx', m.context_length && m.context_length > 0 ? m.context_length : null, ' tokens'),
    set('iArch', knownText(m.arch)),
    set('iQuant', knownText(m.quant)),
  ].some(Boolean);
  const hasDetails = hasTurnDetails || hasModelDetails;
  document.getElementById('statsSummary')?.toggleAttribute('hidden', !hasSummary);
  document.getElementById('statsEmpty')?.toggleAttribute('hidden', hasSummary || hasTurnDetails);
  const details = document.querySelector<HTMLDetailsElement>('#statsDetails');
  if (details) {
    details.hidden = !hasDetails;
    if (!hasDetails) details.open = false;
  }
  updateStatsExpandPreview();
}

/** Paint the metrics strip from the canonical last-turn snapshot. */
export function refreshMetricsStripForChat(chat: Chat): void {
  const mid = chat.modelId?.trim() || '';
  const resolved = resolveLastTurnMetrics(chat);
  if (resolved && lastStatsNeedsHydration(chat.lastStats, resolved)) {
    chat.lastStats = resolved;
    markChatDirty(chat);
  }
  const ls = resolved ?? chat.lastStats;
  const options = { live: isChatStreaming(chat.id) };
  if (!lastStatsHasMetrics(ls)) {
    updateStrip({}, {}, resolveModelInfo(mid, chat.modelInfo || {}), options);
    return;
  }
  updateStrip(
    lastStatsToStats(ls),
    lastStatsToUsage(ls),
    resolveModelInfo(mid, chat.modelInfo || {}),
    options,
  );
}
