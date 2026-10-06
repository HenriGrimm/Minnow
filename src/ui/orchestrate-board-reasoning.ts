import { resolveThinkingMode } from '../agents/resolve-thinking.ts';
import {
  formatThinkingInheritedLabel,
  modelAllowsThinkingMode,
  modelSupportsThinkingControl,
} from '../agents/thinking-capabilities.ts';
import {
  normalizeThinkingTriState,
  type ThinkingTriState,
} from '../agents/thinking-types.ts';
import type { BoardReasoningPatch } from '../orchestrator/board-journal-reasoning.ts';
import {
  defaultComposerReasoningLevel,
  formatReasoningEffortLabel,
  getComposerReasoningLevelOptions,
  isComposerReasoningLevel,
  modelShowsComposerBrainToggle,
  modelUsesAlwaysOnReasoning,
  modelUsesComposerReasoningDropdown,
  modelUsesComposerThinkingToggle,
  normalizeReasoningAllowedOptions,
  resolveEffectiveReasoningEffort,
} from '../lib/reasoning-effort.ts';
import { resolveSendCapabilities } from '../providers/model-capabilities.ts';
import type { ReasoningEffortOption } from '../types.ts';
import { nextThinkingTriStateOnClick } from './composer-thinking.ts';
import { createIcon } from './icon.ts';

/** Persist + display seam so leftover session boards and V2 journal boards share this strip. */
export interface BoardHeaderReasoningSource {
  resolveBinding: () => { providerId: string; modelId: string };
  getBoard: () => {
    thinkingMode?: ThinkingTriState;
    reasoningEffort?: ReasoningEffortOption;
  };
  /** V1 planner chat — used when the board field inherits. */
  getInherit?: () => {
    thinkingMode?: ThinkingTriState;
    reasoningEffort?: ReasoningEffortOption;
  };
  isRunning: () => boolean;
  persist: (patch: BoardReasoningPatch) => void;
  onChanged: () => void;
}

let boardReasoningSource: BoardHeaderReasoningSource | null = null;
let wrapEl: HTMLElement | null = null;
let toggleBtn: HTMLButtonElement | null = null;
let selectEl: HTMLSelectElement | null = null;
let selectWrapEl: HTMLElement | null = null;

// ── Reasoning source ─────────────────────────────────────────────────────────

function effectiveCapabilities(): ReturnType<typeof resolveSendCapabilities> | undefined {
  if (!boardReasoningSource) return undefined;
  const binding = boardReasoningSource.resolveBinding();
  if (!binding.modelId || !binding.providerId) return undefined;
  return resolveSendCapabilities(binding.providerId, binding.modelId);
}

function getLevelOptions(): ReasoningEffortOption[] {
  const caps = effectiveCapabilities();
  return getComposerReasoningLevelOptions(
    normalizeReasoningAllowedOptions(caps?.reasoningAllowedOptions ?? []),
  );
}

function controlsDisabled(): boolean {
  return !boardReasoningSource;
}

function resolveDisplayEffort(levels: ReasoningEffortOption[]): ReasoningEffortOption | undefined {
  if (!boardReasoningSource || levels.length === 0) return undefined;
  const board = boardReasoningSource.getBoard();
  const inherit = boardReasoningSource.getInherit?.() ?? {};
  const caps = effectiveCapabilities();

  if (board.reasoningEffort && levels.includes(board.reasoningEffort)) {
    return board.reasoningEffort;
  }

  const resolved = resolveThinkingMode({
    kind: 'work-agent',
    agentKey: null,
    chatThinkingMode: board.thinkingMode ?? inherit.thinkingMode,
  });
  const effort = resolveEffectiveReasoningEffort(
    { reasoningEffort: board.reasoningEffort ?? inherit.reasoningEffort },
    caps,
    resolved.mode,
  );
  if (effort && levels.includes(effort)) return effort;
  return levels.includes('medium') ? 'medium' : levels[0];
}

function isDropdownReasoningActive(
  caps: ReturnType<typeof resolveSendCapabilities>,
): boolean {
  if (!boardReasoningSource) return false;
  const board = boardReasoningSource.getBoard();
  if (board.reasoningEffort === 'off') return false;
  if (isComposerReasoningLevel(board.reasoningEffort)) {
    return true;
  }
  const resolved = resolveThinkingMode({
    kind: 'work-agent',
    agentKey: null,
    chatThinkingMode: board.thinkingMode,
  });
  const effort = resolveEffectiveReasoningEffort(board, caps, resolved.mode);
  return effort !== 'off' && effort !== undefined;
}

// ── Controls ─────────────────────────────────────────────────────────────────

function persistAndRefresh(patch: BoardReasoningPatch): void {
  if (!boardReasoningSource) return;
  boardReasoningSource.persist(patch);
  syncBoardHeaderReasoning();
  boardReasoningSource.onChanged();
}

function onSelectChange(): void {
  if (!selectEl || selectEl.disabled || !boardReasoningSource) return;
  const levels = getLevelOptions();
  const value = selectEl.value as ReasoningEffortOption;
  if (!levels.includes(value)) return;
  persistAndRefresh({
    reasoningEffort: value,
    clearThinkingMode: true,
  });
}

function applyDropdownModeBrainToggle(): void {
  const caps = effectiveCapabilities();
  if (!boardReasoningSource) return;
  if (modelUsesAlwaysOnReasoning(caps)) return;
  if (boardReasoningSource.getBoard().reasoningEffort === 'off') {
    const level = defaultComposerReasoningLevel(caps);
    persistAndRefresh({
      reasoningEffort: level ?? 'medium',
      clearThinkingMode: true,
    });
    return;
  }
  persistAndRefresh({
    reasoningEffort: 'off',
    clearThinkingMode: true,
  });
}

function applyThinkingTriState(mode: ThinkingTriState): void {
  if (mode === 'inherit') {
    persistAndRefresh({
      clearReasoningEffort: true,
      clearThinkingMode: true,
    });
    return;
  }
  persistAndRefresh({
    thinkingMode: mode,
    clearReasoningEffort: true,
  });
}

function onToggleClick(): void {
  if (!toggleBtn || toggleBtn.disabled || !boardReasoningSource) return;
  const caps = effectiveCapabilities();
  if (modelUsesComposerReasoningDropdown(caps)) {
    applyDropdownModeBrainToggle();
    return;
  }

  const board = boardReasoningSource.getBoard();
  const tri = normalizeThinkingTriState(board.thinkingMode, 'inherit');
  const resolved = resolveThinkingMode({
    kind: 'work-agent',
    agentKey: null,
    chatThinkingMode: board.thinkingMode,
  });
  applyThinkingTriState(nextThinkingTriStateOnClick(tri, resolved.mode));
}

function populateSelect(
  options: ReasoningEffortOption[],
  display: ReasoningEffortOption | undefined,
): void {
  if (!selectEl) return;
  selectEl.replaceChildren();
  for (const option of options) {
    const el = document.createElement('option');
    el.value = option;
    el.textContent = formatReasoningEffortLabel(option);
    selectEl.appendChild(el);
  }
  if (display) selectEl.value = display;
}

function ensureReasoningDom(): void {
  if (wrapEl && toggleBtn && selectEl && selectWrapEl) return;

  wrapEl = document.createElement('div');
  wrapEl.className = 'board-header__reasoning board-reasoning-control-wrap hidden';
  wrapEl.setAttribute('role', 'group');
  wrapEl.setAttribute('aria-label', 'Board reasoning');

  const toggleHost = document.createElement('div');
  toggleHost.className = 'thinking-toggle-host board-reasoning-toggle-host';

  toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'thinking-toggle-btn board-reasoning-toggle-btn';
  toggleBtn.setAttribute('aria-label', 'Board reasoning');
  toggleBtn.appendChild(createIcon('reasoning', { className: 'thinking-toggle-icon' }));
  toggleBtn.addEventListener('click', onToggleClick);
  toggleHost.appendChild(toggleBtn);

  selectWrapEl = document.createElement('div');
  selectWrapEl.className = 'board-reasoning-effort-wrap hidden';

  selectEl = document.createElement('select');
  selectEl.className = 'composer-reasoning-effort-select board-reasoning-effort-select';
  selectEl.setAttribute('aria-label', 'Board reasoning effort');
  selectEl.title = 'Reasoning effort for new attempts. Agents already working keep their current setting.';
  selectEl.dataset.focusKey = 'board-reasoning';
  selectEl.addEventListener('change', onSelectChange);
  selectWrapEl.appendChild(selectEl);

  wrapEl.appendChild(toggleHost);
  wrapEl.appendChild(selectWrapEl);
}

// ── Sync ─────────────────────────────────────────────────────────────────────

/** Place the reasoning strip after the model chip, creating the DOM once. */
export function wireBoardHeaderReasoningSource(
  controls: HTMLElement,
  source: BoardHeaderReasoningSource,
): void {
  boardReasoningSource = source;
  ensureReasoningDom();
  if (!wrapEl) return;

  const stray = controls.querySelector('.board-header__reasoning');
  if (stray && stray !== wrapEl) stray.remove();

  const modelSlot = controls.querySelector('.board-header__model-slot');
  if (modelSlot?.nextSibling) {
    controls.insertBefore(wrapEl, modelSlot.nextSibling);
  } else {
    controls.appendChild(wrapEl);
  }

  syncBoardHeaderReasoning();
}

/** Unparent the strip without destroying it — V2 header paints wipe the pane. */
export function detachBoardHeaderReasoning(): void {
  wrapEl?.remove();
}

/** Keep board reasoning controls aligned after header refresh or model change. */
export function syncBoardHeaderReasoning(): void {
  if (!wrapEl || !toggleBtn) return;

  const caps = effectiveCapabilities();
  const showBrain = modelShowsComposerBrainToggle(caps);
  const dropdownMode = modelUsesComposerReasoningDropdown(caps);
  const toggleMode = modelUsesComposerThinkingToggle(caps);
  const disabled = controlsDisabled();
  const showWrap = showBrain || dropdownMode;
  wrapEl.title = boardReasoningSource?.isRunning()
    ? 'Reasoning changes apply to new attempts. Agents already working keep their current setting.'
    : 'Reasoning for board agents';

  wrapEl.classList.toggle('hidden', !showWrap);
  toggleBtn.classList.toggle('hidden', !showBrain);

  if (!showWrap) {
    if (selectWrapEl) selectWrapEl.classList.add('hidden');
    return;
  }

  if (dropdownMode) {
    const alwaysOn = modelUsesAlwaysOnReasoning(caps);
    const effectiveOn = alwaysOn || isDropdownReasoningActive(caps);
    if (showBrain) {
      toggleBtn.setAttribute('aria-pressed', effectiveOn ? 'true' : 'false');
      toggleBtn.dataset.inherit = 'false';
      toggleBtn.dataset.thinkingTri = effectiveOn ? 'on' : 'off';
      toggleBtn.disabled = disabled;
      toggleBtn.title = effectiveOn
        ? 'Board reasoning on — click to turn off'
        : 'Board reasoning off — click to turn on';
    }

    const showLevel = effectiveOn;
    if (selectWrapEl) selectWrapEl.classList.toggle('hidden', !showLevel);
    if (selectEl) {
      selectEl.disabled = disabled || !showLevel;
      if (showLevel) {
        const levels = getLevelOptions();
        populateSelect(levels, resolveDisplayEffort(levels));
      }
    }
    return;
  }

  if (!toggleMode) {
    toggleBtn.disabled = true;
    if (selectWrapEl) selectWrapEl.classList.add('hidden');
    return;
  }

  const boardState = boardReasoningSource?.getBoard();
  const tri = normalizeThinkingTriState(boardState?.thinkingMode, 'inherit');
  const resolved = resolveThinkingMode({
    kind: 'work-agent',
    agentKey: null,
    chatThinkingMode: boardState?.thinkingMode,
  });
  const supports = modelSupportsThinkingControl(caps);
  const effectiveOn = resolved.mode === 'on';
  const allowed = supports && modelAllowsThinkingMode(caps, resolved.mode);

  toggleBtn.setAttribute('aria-pressed', effectiveOn ? 'true' : 'false');
  toggleBtn.dataset.inherit = tri === 'inherit' ? 'true' : 'false';
  toggleBtn.dataset.thinkingTri = tri;
  toggleBtn.disabled = !allowed || disabled;

  if (!supports) {
    toggleBtn.title = 'Board model does not advertise reasoning support';
  } else if (!allowed) {
    toggleBtn.title = `Board model does not support reasoning ${resolved.mode}`;
  } else if (tri === 'inherit') {
    toggleBtn.title = formatThinkingInheritedLabel(tri, resolved.mode, resolved.sourceLabel);
  } else {
    toggleBtn.title = effectiveOn
      ? 'Board reasoning on (override)'
      : 'Board reasoning off (override)';
  }

  if (selectWrapEl) selectWrapEl.classList.add('hidden');
}

/** Tear down board reasoning controls when leaving board view. */
export function teardownBoardHeaderReasoning(): void {
  wrapEl?.remove();
  wrapEl = null;
  toggleBtn = null;
  selectEl = null;
  selectWrapEl = null;
  boardReasoningSource = null;
}
