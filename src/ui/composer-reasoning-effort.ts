import { resolveThinkingMode } from '../agents/resolve-thinking';
import { isActiveChatStreaming } from '../chat/streaming-state';
import {
  formatReasoningEffortLabel,
  getComposerReasoningLevelOptions,
  isComposerReasoningLevel,
  legacyMtplxReasoningEffort,
  modelUsesAlwaysOnReasoning,
  modelShowsComposerBrainToggle,
  modelUsesComposerReasoningLevelDropdown,
  normalizeReasoningAllowedOptions,
  resolveEffectiveReasoningEffort,
} from '../lib/reasoning-effort';
import { resolveSendCapabilities } from '../providers/model-capabilities';
import { resolveActiveWorkAgent } from '../agents/resolve-work-agent';
import {
  getActiveChat,
  scheduleSaveSessions,
  touchChat,
} from '../state/sessions';
import type { Chat, ReasoningEffortOption as EffortOption } from '../types';
import { syncThinkingControlFromActiveChat } from './composer-thinking';
import { syncComposerCodeMapFromActiveChat } from './composer-code-map';
import { syncComposerContextDocumentsFromActiveChat } from './composer-context-documents';
import { isComposerRecoveryBlocked } from './composer-send';
import { modelCache } from '../app-state';
import { decodeModelSelectKey } from '../lib/model-select-key';
import { favoriteReasoningLevel, savedReasoningFavorite, saveReasoningFavorite } from '../models/reasoning-favorite';
import { cursorVariantFamilyKey, cursorVariantParts, resolveCursorVariantId, usesCliReasoningFavorite } from '../models/cursor-variants.mjs';
import { resolveComposerModelSelectValue, syncComposerModelTriggers } from './composer-model-trigger';
import { configureManagedChatModel, isManagedModelBusy, managedChatModelSelection, managedModelReadOnlyReason, managedReasoningSelection } from './managed-chat-model';
import { showToast } from './toast';

let selectEl: HTMLSelectElement | null = null;
let wrapEl: HTMLElement | null = null;
let segmentsEl: HTMLElement | null = null;
let cursorFastButton: HTMLButtonElement | null = null;

// ── Options ──────────────────────────────────────────────────────────────────

function reasoningModelBinding(chat: Chat) {
  return decodeModelSelectKey(resolveComposerModelSelectValue(chat));
}

export function getComposerReasoningCapabilities(binding = reasoningModelBinding(getActiveChat())): ReturnType<typeof resolveSendCapabilities> {
  return binding ? resolveSendCapabilities(binding.providerId, binding.modelId) : undefined;
}

function getLevelOptions(caps = getComposerReasoningCapabilities()): EffortOption[] {
  return getComposerReasoningLevelOptions(normalizeReasoningAllowedOptions(caps?.reasoningAllowedOptions ?? []));
}

/** Drop saved effort when the active model no longer allows it. */
function validateAndClearInvalidEffort(): void {
  const chat = getActiveChat();
  if (chat.chatCommandVersion === 1) return;
  if (!chat.reasoningEffort) return;
  const caps = getComposerReasoningCapabilities();
  // Cold boot can render the chat before its catalog supplies capabilities.
  if (!caps) return;
  const levels = getLevelOptions(caps);
  if (chat.reasoningEffort === 'off' && !modelUsesAlwaysOnReasoning(caps)) return;
  const effort = legacyMtplxReasoningEffort(chat.reasoningEffort, caps, chat.modelId);
  if (isComposerReasoningLevel(effort) && levels.includes(effort)) {
    return;
  }
  delete chat.reasoningEffort;
  touchChat(chat);
  scheduleSaveSessions();
}

function resolveDisplayEffort(levels: EffortOption[], caps = getComposerReasoningCapabilities()): EffortOption | undefined {
  if (levels.length === 0) return undefined;
  const chat = getActiveChat();
  if (chat.reasoningEffort && levels.includes(chat.reasoningEffort)) {
    return chat.reasoningEffort;
  }
  const agent = resolveActiveWorkAgent(chat);
  const resolved = resolveThinkingMode({
    kind: 'work-agent',
    agentKey: agent?.id ?? null,
    chatThinkingMode: chat.thinkingMode,
  });
  const binding = reasoningModelBinding(chat);
  const favorite = chat.chatCommandVersion === 1 && usesCliReasoningFavorite(binding?.providerId) && chat.thinkingMode !== 'off'
    ? favoriteReasoningLevel(binding?.providerId, binding?.modelId) : undefined;
  const effort = resolveEffectiveReasoningEffort(favorite ? { reasoningEffort: favorite } : chat, caps, favorite ? 'on' : resolved.mode, chat.modelId);
  if (effort && levels.includes(effort)) return effort;
  return levels.includes('medium') ? 'medium' : levels[0];
}

// ── Populate ─────────────────────────────────────────────────────────────────

function populateSelect(options: EffortOption[], display: EffortOption | undefined): void {
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

/** Keep internal reasoning controls aligned with the chat binding. */
function populateSegments(options: EffortOption[], display: EffortOption | undefined): void {
  if (!segmentsEl) return;
  segmentsEl.replaceChildren();
  for (const option of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'composer-reasoning-effort-segment';
    button.dataset.value = option;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', display === option ? 'true' : 'false');
    button.textContent = formatReasoningEffortLabel(option);
    segmentsEl.appendChild(button);
  }
}

function onSegmentClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  if (!target.classList.contains('composer-reasoning-effort-segment')) return;
  if (!selectEl || selectEl.disabled) return;
  const value = target.dataset.value as EffortOption | undefined;
  if (!value) return;
  selectEl.value = value;
  selectEl.dispatchEvent(new Event('change'));
}

export interface ComposerReasoningChoice {
  value: EffortOption | 'inherit';
  label: string;
  /** Effort levels can be starred as the model's favorite. */
  level?: EffortOption;
}

/** Current chat reasoning, shared by the model label and its menu. */
export function getComposerReasoningState() {
  const chat = getActiveChat();
  const binding = reasoningModelBinding(chat);
  const caps = getComposerReasoningCapabilities(binding);
  const allowed = normalizeReasoningAllowedOptions(caps?.reasoningAllowedOptions ?? []);
  const levels = getComposerReasoningLevelOptions(allowed);
  const toggle = modelShowsComposerBrainToggle(caps);
  const agent = resolveActiveWorkAgent(chat);
  const resolved = resolveThinkingMode({
    kind: 'work-agent', agentKey: agent?.id ?? null, chatThinkingMode: chat.thinkingMode,
  });
  const favorite = levels.length ? favoriteReasoningLevel(binding?.providerId, binding?.modelId) : undefined;
  const followsCliFavorite = chat.chatCommandVersion === 1 && usesCliReasoningFavorite(binding?.providerId)
    && !chat.reasoningEffort && chat.thinkingMode !== 'off' && favorite;
  const effective = followsCliFavorite || resolveEffectiveReasoningEffort(chat, caps, resolved.mode, chat.modelId) || resolved.mode;
  const choices: ComposerReasoningChoice[] = [];
  if (levels.length || toggle) {
    choices.push({ value: 'inherit', label: 'Default' });
    if (toggle) choices.push({ value: 'off', label: 'Off' });
    if (levels.length) {
      choices.push(...levels.map(value => ({ value, label: formatReasoningEffortLabel(value), level: value })));
    } else {
      choices.push({ value: 'on', label: 'On' });
    }
  }
  const label = levels.length && effective !== 'off'
    ? formatReasoningEffortLabel(resolveDisplayEffort(levels, caps) ?? effective)
    : `Reasoning ${effective === 'off' ? 'off' : 'on'}`;
  return {
    label: choices.length && (caps?.reasoning === true || allowed.length || chat.thinkingMode || chat.reasoningEffort) ? label : '', choices,
    selected: (legacyMtplxReasoningEffort(chat.reasoningEffort, caps, chat.modelId) ?? chat.thinkingMode ?? 'inherit') as ComposerReasoningChoice['value'],
    favorite,
    disabled: (chat.chatCommandVersion === 1 ? Boolean(managedModelReadOnlyReason(chat)) || isManagedModelBusy(chat.id) : isActiveChatStreaming()) || isComposerRecoveryBlocked(),
  };
}

/** Apply a chat override without changing the model's favorite. "Default" uses the favorite. */
export function setComposerReasoningChoice(value: string): void {
  const state = getComposerReasoningState();
  if (state.disabled || !state.choices.some(choice => choice.value === value)) return;
  const chat = getActiveChat();
  const binding = reasoningModelBinding(chat);
  if (chat.chatCommandVersion === 1) {
    const target = value === 'inherit' && !usesCliReasoningFavorite(binding?.providerId) ? state.favorite ?? value : value;
    void configureManagedChatModel(chat, managedReasoningSelection(chat, target, getLevelOptions().length > 0))
      .catch(error => showToast(String(error?.message || error), 'error')).finally(syncComposerReasoningEffortFromActiveChat);
    syncComposerReasoningEffortFromActiveChat(); return;
  }
  if (value === 'inherit') {
    const saved = savedReasoningFavorite(binding?.providerId, binding?.modelId);
    if (saved) chat.reasoningEffort = saved;
    else delete chat.reasoningEffort;
    delete chat.thinkingMode;
  } else if (getLevelOptions().length) {
    chat.reasoningEffort = value as EffortOption;
  } else {
    delete chat.reasoningEffort;
    chat.thinkingMode = value === 'off' ? 'off' : 'on';
  }
  touchChat(chat);
  scheduleSaveSessions();
  syncComposerReasoningEffortFromActiveChat();
}

/**
 * Star (or unstar) a level as the active model's favorite. A chat still on
 * "Default" adopts a newly starred level; explicit chat choices are left alone.
 */
export function toggleComposerReasoningFavorite(level: string): void {
  const state = getComposerReasoningState();
  const choice = state.choices.find(entry => entry.level === level);
  if (!choice?.level) return;
  const chat = getActiveChat();
  const binding = reasoningModelBinding(chat);
  const next = state.favorite === choice.level ? null : choice.level;
  void saveReasoningFavorite(binding?.providerId, binding?.modelId, next)
    .catch(error => showToast(`Could not save favorite reasoning: ${String(error?.message || error)}`, 'error'));
  if (next && state.selected === 'inherit' && !state.disabled &&
      !(chat.chatCommandVersion === 1 && usesCliReasoningFavorite(binding?.providerId))) setComposerReasoningChoice('inherit');
  else syncComposerReasoningEffortFromActiveChat();
}

function onSelectChange(): void {
  if (!selectEl || selectEl.disabled) return;
  const levels = getLevelOptions();
  const value = selectEl.value as EffortOption;
  if (!levels.includes(value)) return;

  setComposerReasoningChoice(value);
}

function cursorModelIds(): string[] {
  return [...modelCache.keys()].flatMap((key) => {
    const binding = decodeModelSelectKey(key);
    return binding?.providerId === 'cursor-agent-cli' ? [binding.modelId] : [];
  });
}

/** Keep the saved binding and model chip aligned with the composer controls. */
function syncCursorModelVariant(): void {
  const chat = getActiveChat();
  if (chat.chatCommandVersion === 1) return;
  if (chat.providerId !== 'cursor-agent-cli' || !chat.modelId) return;
  const fast = chat.cursorFast ?? cursorVariantParts(chat.modelId)?.fast ?? false;
  const modelId = resolveCursorVariantId(chat.modelId, cursorModelIds(), {
    effort: chat.reasoningEffort, fast,
  });
  if (modelId === chat.modelId) return;
  chat.modelId = modelId;
  chat.cursorFast = fast;
  touchChat(chat);
  scheduleSaveSessions();
  syncComposerModelTriggers();
}

function ensureCursorFastButton(): void {
  if (!wrapEl || (cursorFastButton?.isConnected && cursorFastButton.ownerDocument === document)) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'composerCursorFast';
  button.className = 'composer-cursor-fast-btn hidden';
  const track = document.createElement('span');
  track.className = 'composer-cursor-fast-btn__track';
  track.setAttribute('aria-hidden', 'true');
  button.append(track, 'Fast');
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-label', 'Cursor fast mode');
  button.addEventListener('click', () => {
    if (button.disabled) return;
    const chat = getActiveChat();
    const current = chat.chatCommandVersion === 1 ? cursorVariantParts(chat.modelId)?.fast ?? false : chat.cursorFast ?? cursorVariantParts(chat.modelId)?.fast ?? false;
    if (chat.chatCommandVersion === 1) {
      const modelId = resolveCursorVariantId(chat.modelId, cursorModelIds(), { effort: chat.reasoningEffort, fast: !current });
      void configureManagedChatModel(chat, { ...managedChatModelSelection(chat), modelId })
        .catch(error => showToast(String(error?.message || error), 'error')).finally(syncComposerReasoningEffortFromActiveChat);
      syncComposerReasoningEffortFromActiveChat(); return;
    }
    chat.cursorFast = !current;
    touchChat(chat);
    scheduleSaveSessions();
    syncComposerReasoningEffortFromActiveChat();
  });
  (wrapEl.parentElement ?? wrapEl).after(button);
  cursorFastButton = button;
}

function syncCursorFastButton(): void {
  if (!cursorFastButton) return;
  const chat = getActiveChat();
  const family = cursorVariantFamilyKey(chat.modelId);
  const effort = chat.reasoningEffort ?? cursorVariantParts(chat.modelId)?.effort;
  const fastVariants = chat.providerId === 'cursor-agent-cli'
    ? cursorModelIds().filter(id => cursorVariantFamilyKey(id) === family && cursorVariantParts(id)?.fast)
    : [];
  const available = fastVariants.some(id => !effort || cursorVariantParts(id)?.effort === effort);
  cursorFastButton.classList.toggle('hidden', fastVariants.length === 0);
  cursorFastButton.disabled = !available || (chat.chatCommandVersion === 1 ? Boolean(managedModelReadOnlyReason(chat)) || isManagedModelBusy(chat.id) : isActiveChatStreaming()) || isComposerRecoveryBlocked();
  cursorFastButton.setAttribute('aria-checked', String(available && Boolean(cursorVariantParts(chat.modelId)?.fast)));
  cursorFastButton.title = available ? 'Use Cursor fast mode' : 'Fast mode is unavailable at this reasoning level';
}

function isLevelDropdownVisible(): boolean {
  const caps = getComposerReasoningCapabilities();
  if (!modelUsesComposerReasoningLevelDropdown(caps)) return false;
  if (modelUsesAlwaysOnReasoning(caps)) return true;
  return getActiveChat().reasoningEffort !== 'off';
}

// ── Init ─────────────────────────────────────────────────────────────────────

/** Wire native reasoning state used by the composer model menu. */
export function initComposerReasoningEffort(): void {
  selectEl = document.getElementById('composerReasoningEffortSelect') as HTMLSelectElement | null;
  wrapEl = document.getElementById('composerReasoningEffortWrap');
  segmentsEl = document.getElementById('composerReasoningEffortSegments');
  selectEl?.addEventListener('change', onSelectChange);
  segmentsEl?.addEventListener('click', onSegmentClick);
  ensureCursorFastButton();
  syncComposerReasoningEffortFromActiveChat();
}

/** Refresh dropdown options, visibility, and disabled state. */
export function syncComposerReasoningEffortFromActiveChat(): void {
  validateAndClearInvalidEffort();
  syncCursorModelVariant();

  const visible = isLevelDropdownVisible();
  const chat = getActiveChat();
  const disabled = (chat.chatCommandVersion === 1 ? Boolean(managedModelReadOnlyReason(chat)) || isManagedModelBusy(chat.id) : isActiveChatStreaming()) || isComposerRecoveryBlocked();

  if (wrapEl) wrapEl.classList.toggle('hidden', !visible);
  if (selectEl) {
    selectEl.disabled = !visible || disabled;
    if (visible) {
      const levels = getLevelOptions();
      const display = resolveDisplayEffort(levels);
      populateSelect(levels, display);
      populateSegments(levels, display);
    }
  }
  if (segmentsEl) {
    for (const button of segmentsEl.querySelectorAll<HTMLButtonElement>('.composer-reasoning-effort-segment')) {
      button.disabled = !visible || disabled;
    }
  }
  syncCursorFastButton();

  syncThinkingControlFromActiveChat();
  syncComposerModelTriggers();
  void syncComposerCodeMapFromActiveChat();
  void syncComposerContextDocumentsFromActiveChat();
}

/** Re-run sync when streaming / recovery gates change (loop.ts). */
export function refreshComposerReasoningEffortDisabled(): void {
  syncComposerReasoningEffortFromActiveChat();
}

