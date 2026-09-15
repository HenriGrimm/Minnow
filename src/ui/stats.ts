import { STATS_STRIP_OPEN_KEY } from '../constants';
import { resolveModelInfo } from '../api/models';
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

/** Show or hide the entire metrics strip; syncs the top-bar toggle. */
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

/** Wire top-bar metrics button and restore last open/closed preference. */
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
  const preview = document.getElementById('statsExpandPreview');
  if (!preview) return;
  const tpsEl = document.getElementById('stripTPS');
  const totalEl = document.getElementById('stripTotal');
  if (!tpsEl || !totalEl) return;
  const tps = tpsEl.textContent?.trim() ?? '';
  const total = totalEl.textContent?.trim() ?? '';
  preview.textContent = `${tps} t/s · ${total} tokens`;

  const barPreview = document.getElementById('statusMetricPreview');
  if (barPreview) barPreview.textContent = `${tps || '—'} t/s`;
}

export interface UpdateStripOptions {
  /** Override cost chip (e.g. board-wide rollup). */
  costUsd?: number | null;
}

/** Refresh bottom metrics strip and token bars from latest turn data. */
export function updateStrip(
  stats: Stats | undefined,
  usage: Usage | undefined,
  modelInfo: ModelInfo | undefined,
  options?: UpdateStripOptions,
): void {
  const snapshot = buildLastStatsSnapshot(stats, usage);
  const s = lastStatsToStats(snapshot);
  const m = modelInfo || {};

  function set(id: string, html: string, blank: boolean, title?: string): void {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = html;
    el.classList.toggle('blank', blank);
    if (title) el.setAttribute('title', title);
    else el.removeAttribute('title');
  }

  /** Apply compact M/B (or comma) formatting with a full-number hover title. */
  function setCount(id: string, value: number | null | undefined): void {
    const formatted = formatStatCount(value);
    const blank = formatted.display === '—';
    set(id, formatted.display, blank, blank ? undefined : formatted.full);
  }

  set(
    'stripTPS',
    s.tokens_per_second != null ? s.tokens_per_second.toFixed(1) : '—',
    s.tokens_per_second == null
  );

  set(
    'stripTTFT',
    s.time_to_first_token != null
      ? `${s.time_to_first_token.toFixed(3)}<span class="stat-unit">s</span>`
      : '—',
    s.time_to_first_token == null
  );

  set(
    'stripGen',
    s.generation_time != null
      ? `${s.generation_time.toFixed(3)}<span class="stat-unit">s</span>`
      : '—',
    s.generation_time == null
  );

  setCount('stripTotal', snapshot.total_tokens);

  let costLabel = '—';
  if (options?.costUsd != null && options.costUsd > 0) {
    costLabel = formatUsd(options.costUsd);
  } else if (options?.costUsd === undefined) {
    try {
      const ledger = getActiveChat().tokenLedger;
      const lastEntry = ledger?.entries?.[ledger.entries.length - 1];
      if (lastEntry?.costUsd != null && lastEntry.costUsd > 0) {
        costLabel = formatUsd(lastEntry.costUsd);
      }
    } catch {
      // Catalog refresh can run before sessions hydrate.
    }
  }
  set('stripCost', costLabel, costLabel === '—');

  const p = snapshot.prompt_tokens ?? 0;
  const c = snapshot.completion_tokens ?? 0;
  const t = p + c || 1;
  const barPrompt = document.getElementById('barPrompt');
  const barCompletion = document.getElementById('barCompletion');
  const cntPrompt = document.getElementById('cntPrompt');
  const cntCompletion = document.getElementById('cntCompletion');
  if (barPrompt && barCompletion && cntPrompt && cntCompletion) {
    barPrompt.style.setProperty('--fill-scale', String(p / t || 0));
    barCompletion.style.setProperty('--fill-scale', String(c / t || 0));
    const promptFmt = formatStatCount(snapshot.prompt_tokens);
    const completionFmt = formatStatCount(snapshot.completion_tokens);
    const promptBlank = promptFmt.display === '—';
    const completionBlank = completionFmt.display === '—';
    cntPrompt.textContent = promptFmt.display;
    cntCompletion.textContent = completionFmt.display;
    if (!promptBlank) cntPrompt.setAttribute('title', promptFmt.full);
    else cntPrompt.removeAttribute('title');
    if (!completionBlank) cntCompletion.setAttribute('title', completionFmt.full);
    else cntCompletion.removeAttribute('title');
  }

  const archEl = document.getElementById('iArch');
  const quantEl = document.getElementById('iQuant');
  const ctxEl = document.getElementById('iCtx');
  const stopEl = document.getElementById('iStop');
  if (!archEl || !quantEl || !ctxEl || !stopEl) {
    return;
  }
  archEl.textContent = m.arch ?? '—';
  quantEl.textContent = m.quant ?? '—';
  ctxEl.textContent = m.context_length != null ? String(m.context_length) : '—';
  stopEl.textContent = s.stop_reason ?? '—';
  [archEl, quantEl, ctxEl].forEach((el) => {
    el.classList.toggle('lit', el.textContent !== '—');
  });
  stopEl.classList.toggle('lit', stopEl.textContent !== '—');
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
  if (!lastStatsHasMetrics(ls)) {
    updateStrip({}, {}, resolveModelInfo(mid, chat.modelInfo || {}));
    return;
  }
  updateStrip(
    lastStatsToStats(ls),
    lastStatsToUsage(ls),
    resolveModelInfo(mid, chat.modelInfo || {}),
  );
}
