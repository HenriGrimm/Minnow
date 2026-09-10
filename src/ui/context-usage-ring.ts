import { getContextInFlightOverlay } from '../chat/context-in-flight';
import {
  estimateAttachmentTokens,
  getContextBudget,
  type ContextBudget,
} from '../chat/context-usage';
import { TOKEN_ESTIMATE_TOOLTIP } from '../chat/prompts/token-estimate-core';
import { formatStatCount } from '../usage/format-stat-count';
import { getPendingAttachments } from '../attachments/store';
import { resolveEffectiveChatModelBinding } from './default-model';
import { getActiveChat, sessionState } from '../state/sessions';
import { getActiveComposerSurface } from './composer-surface';
import {
  bindContextUsageProfileTabs,
  closeContextUsageBreakdown,
  isContextUsageBreakdownOpen,
  syncContextUsageBreakdownIfOpen,
  toggleContextUsageBreakdown,
} from './context-usage-breakdown';
import {
  getActiveContextUsageSurface,
  getContextUsageRingButton,
  getContextUsageRingSvg,
  listContextUsageSurfaces,
  type ContextUsageSurface,
} from './context-usage-surface';

const COMPOSER_REFRESH_DEBOUNCE_MS = 450;
const STREAMING_CONTEXT_REFRESH_MS = 1000;
/** Skip history re-tokenizing while the composer is being edited (macOS glyph lag). */
const COMPOSER_TYPING_QUIET_MS = 2000;

let lastComposerInputAt = 0;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let streamThrottleLastFire = 0;
let streamThrottleTrailingTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let lastBudget: ContextBudget | null = null;
/** Bumps on each refresh so slower async estimates cannot paint a prior chat. */
let refreshGeneration = 0;

const WARN_PERCENT = 85;

function readPendingComposerText(): string {
  return getActiveComposerSurface().inputEl?.value ?? '';
}

function formatCount(n: number): string {
  return formatStatCount(n).full || formatStatCount(n).display;
}

function formatUsedLabel(budget: ContextBudget): string {
  const count = formatCount(budget.used);
  return budget.isEstimate ? `~${count}` : count;
}

function formatTooltip(budget: ContextBudget): string {
  const lines: string[] = [budget.modelDisplayName];
  if (budget.limit != null) {
    lines.push(`Context: ${formatCount(budget.limit)} tokens`);
  } else {
    lines.push('Context limit unknown — compression disabled');
  }
  lines.push(`${budget.isEstimate ? 'Context used (approx.)' : 'Context used'}: ${formatUsedLabel(budget)}`);
  if (budget.sessionUsage) {
    lines.push(`Session usage: ${formatCount(budget.sessionUsage.totalTokens)} tokens across ${budget.sessionUsage.completionCount} requests`);
  }
  if (budget.remaining != null) {
    const remaining = formatCount(budget.remaining);
    lines.push(
      budget.isEstimate
        ? `Remaining (approx.): ~${remaining}`
        : `Remaining: ${remaining}`,
    );
  }
  if (budget.compressAtTokens != null) {
    lines.push(
      budget.willCompress
        ? `Compressing history — over ${formatCount(budget.compressAtTokens)} tokens`
        : `Compresses history above ${formatCount(budget.compressAtTokens)} tokens`,
    );
  }
  if (budget.lastTurnPromptTokens != null) {
    const parts = [`prompt ${formatCount(budget.lastTurnPromptTokens)}`];
    if (budget.lastTurnCompletionTokens != null) {
      parts.push(`completion ${formatCount(budget.lastTurnCompletionTokens)}`);
    }
    if (budget.lastTurnTotalTokens != null) {
      parts.push(`total ${formatCount(budget.lastTurnTotalTokens)}`);
    }
    lines.push(`Last round (API): ${parts.join(', ')}`);
  }
  lines.push(TOKEN_ESTIMATE_TOOLTIP);
  return lines.join('\n');
}

function paintRingSurface(surface: ContextUsageSurface, budget: ContextBudget): void {
  const button = getContextUsageRingButton(surface);
  const svg = getContextUsageRingSvg(surface);
  if (!button || !svg) return;

  const percent = budget.percent ?? 0;
  // Warn before the enforcement ceiling, and never after it.
  const warn = budget.willCompress || (budget.percent != null && budget.percent >= WARN_PERCENT);
  button.classList.toggle('context-usage-ring--warn', warn);
  button.classList.toggle('context-usage-ring--unknown-limit', budget.limit == null);

  const track = svg.querySelector('.context-usage-ring__track') as SVGCircleElement | null;
  const fill = svg.querySelector('.context-usage-ring__fill') as SVGCircleElement | null;
  if (track && fill) {
    const radius = 10;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference * (1 - Math.min(1, percent / 100));
    fill.style.strokeDasharray = `${circumference}`;
    fill.style.strokeDashoffset = String(offset);
  }

  svg.querySelector('.context-usage-ring__fill-code-map')?.remove();

  const usedLabel = formatUsedLabel(budget);
  const label =
    budget.limit != null
      ? `Context ${percent}% used, ${usedLabel} of ${formatCount(budget.limit)} tokens`
      : `Context ${usedLabel} tokens used, limit unknown`;
  button.setAttribute('aria-label', label);
  button.title = formatTooltip(budget);
}

function paintUnavailable(surface: ContextUsageSurface): void {
  const button = getContextUsageRingButton(surface);
  if (!button) return;
  button.classList.remove('context-usage-ring--warn');
  button.setAttribute('aria-label', 'Context usage unavailable');
  button.title = 'Could not estimate context usage.';
}

function shouldApplyRefreshResult(generation: number, chatIdAtStart: string): boolean {
  if (generation !== refreshGeneration) return false;
  return sessionState?.activeId === chatIdAtStart;
}

async function runRefresh(generation: number): Promise<void> {
  if (!sessionState) return;
  const chat = getActiveChat();
  const chatIdAtStart = chat.id;
  try {
    const { selectValue } = resolveEffectiveChatModelBinding(chat);
    const modelId = selectValue || chat.modelId || '';
    const budget = await getContextBudget({
      chat,
      modelId,
      pendingComposerText: readPendingComposerText(),
      pendingAttachmentTokens: estimateAttachmentTokens(getPendingAttachments()),
      inFlight: getContextInFlightOverlay(chat.id),
    });
    if (!shouldApplyRefreshResult(generation, chatIdAtStart)) return;
    lastBudget = budget;
    // Every mounted ring tracks the one active chat, so paint them all — a
    // background surface must never keep a stale number to show on app switch.
    for (const surface of listContextUsageSurfaces()) {
      paintRingSurface(surface, budget);
    }
    syncContextUsageBreakdownIfOpen(budget);
  } catch {
    if (!shouldApplyRefreshResult(generation, chatIdAtStart)) return;
    for (const surface of listContextUsageSurfaces()) {
      paintUnavailable(surface);
    }
  }
}

/** Recompute context ring immediately. */
export function refreshContextUsageRing(): void {
  if (!sessionState) return;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  const generation = ++refreshGeneration;
  inFlight = runRefresh(generation).finally(() => {
    inFlight = null;
  });
}

/** True when a composer keystroke landed recently enough to skip idle token work. */
function composerTypingIsHot(): boolean {
  return lastComposerInputAt > 0 && Date.now() - lastComposerInputAt < COMPOSER_TYPING_QUIET_MS;
}

/** Debounced refresh (tool toggles). Streaming uses a leading+trailing throttle so the ring updates while tokens flow (MIN-584). */
export function scheduleContextUsageRefresh(options?: { duringStream?: boolean }): void {
  if (composerTypingIsHot()) return;
  if (options?.duringStream) {
    const now = Date.now();
    const elapsed = streamThrottleLastFire === 0 ? STREAMING_CONTEXT_REFRESH_MS : now - streamThrottleLastFire;
    if (elapsed >= STREAMING_CONTEXT_REFRESH_MS) {
      streamThrottleLastFire = now;
      if (streamThrottleTrailingTimer) {
        clearTimeout(streamThrottleTrailingTimer);
        streamThrottleTrailingTimer = null;
      }
      refreshContextUsageRing();
      return;
    }
    if (streamThrottleTrailingTimer) return;
    const remaining = STREAMING_CONTEXT_REFRESH_MS - elapsed;
    streamThrottleTrailingTimer = setTimeout(() => {
      streamThrottleTrailingTimer = null;
      streamThrottleLastFire = Date.now();
      if (composerTypingIsHot()) return;
      refreshContextUsageRing();
    }, remaining);
    return;
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (composerTypingIsHot()) return;
    refreshContextUsageRing();
  }, COMPOSER_REFRESH_DEBOUNCE_MS);
}

function bindRingButton(surface: ContextUsageSurface): void {
  const button = getContextUsageRingButton(surface);
  if (!button || button.dataset.contextRingBound === '1') return;
  button.dataset.contextRingBound = '1';

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const active = getActiveContextUsageSurface();
    if (surface.ringId !== active.ringId) return;
    if (lastBudget) {
      toggleContextUsageBreakdown(lastBudget, surface);
    } else {
      const generation = ++refreshGeneration;
      void runRefresh(generation).then(() => {
        if (lastBudget) toggleContextUsageBreakdown(lastBudget, surface);
      });
    }
  });
}

/** Bind any context rings added after initial boot (e.g. desktop composer). */
export function bindContextUsageRings(): void {
  bindContextUsageProfileTabs();
  for (const surface of listContextUsageSurfaces()) {
    bindRingButton(surface);
  }
}

let initialized = false;

/** Mount ring handlers and listeners (call once from initApp). */
export function initContextUsageRing(): void {
  if (initialized) return;
  initialized = true;

  bindContextUsageProfileTabs();

  for (const surface of listContextUsageSurfaces()) {
    bindRingButton(surface);
  }

  document.addEventListener('click', (event) => {
    if (!isContextUsageBreakdownOpen()) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    for (const surface of listContextUsageSurfaces()) {
      const button = getContextUsageRingButton(surface);
      const panel = document.getElementById(surface.breakdownId);
      if (button?.contains(target) || panel?.contains(target)) return;
    }
    closeContextUsageBreakdown();
  });

  for (const { inputId } of [
    { inputId: 'msgInput' },
    { inputId: 'chatAppInput' },
    { inputId: 'desktopInput' },
  ]) {
    document.getElementById(inputId)?.addEventListener('input', () => {
      lastComposerInputAt = Date.now();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    });
  }

  const modelSelect = document.getElementById('modelSelect');
  modelSelect?.addEventListener('change', () => refreshContextUsageRing());

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshContextUsageRing();
  });
}

/** Latest budget snapshot (tests / debug). */
export function getLastContextBudget(): ContextBudget | null {
  return lastBudget;
}

/** Reset module state between unit tests. */
export function resetContextUsageRingForTests(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (streamThrottleTrailingTimer) {
    clearTimeout(streamThrottleTrailingTimer);
    streamThrottleTrailingTimer = null;
  }
  streamThrottleLastFire = 0;
  inFlight = null;
  lastBudget = null;
  refreshGeneration = 0;
  lastComposerInputAt = 0;
}
