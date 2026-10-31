import { resolveThinkingMode } from '../agents/resolve-thinking';
import { isActiveChatStreaming } from '../chat/streaming-state';
import {
  formatReasoningEffortLabel,
  getComposerReasoningLevelOptions,
  isComposerReasoningLevel,
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
import type { ReasoningEffortOption as EffortOption } from '../types';
import { syncThinkingControlFromActiveChat } from './composer-thinking';
import { syncComposerCodeMapFromActiveChat } from './composer-code-map';
import { syncComposerBrainNotesFromActiveChat } from './composer-brain-notes';
import { syncComposerContextDocumentsFromActiveChat } from './composer-context-documents';
import { isComposerRecoveryBlocked } from './composer-send';
import { modelCache } from '../app-state';
import { getModelReasoningDefault } from '../config/model-reasoning-defaults';
import { decodeModelSelectKey, encodeModelSelectKey } from '../lib/model-select-key';
import { cursorVariantFamilyKey, cursorVariantParts, resolveCursorVariantId } from '../models/cursor-variants.mjs';
import { syncComposerModelTriggers } from './composer-model-trigger';
import { configureManagedChatModel, isManagedModelBusy, managedChatModelSelection, managedModelReadOnlyReason, managedReasoningSelection } from './managed-chat-model';
import { showToast } from './toast';

let selectEl: HTMLSelectElement | null = null;
let wrapEl: HTMLElement | null = null;
let segmentsEl: HTMLElement | null = null;
let cursorFastButton: HTMLButtonElement | null = null;

// ── Options ──────────────────────────────────────────────────────────────────

function effectiveCapabilities(): ReturnType<typeof resolveSendCapabilities> {
  const chat = getActiveChat();
  const modelId = chat.modelId?.trim();
  const providerId = chat.providerId?.trim();
  if (!modelId || !providerId) return undefined;
  return resolveSendCapabilities(providerId, modelId);
}

function getAllowedOptions(): EffortOption[] {
  const caps = effectiveCapabilities();
  return normalizeReasoningAllowedOptions(caps?.reasoningAllowedOptions ?? []);
}

function getLevelOptions(): EffortOption[] {
  return getComposerReasoningLevelOptions(getAllowedOptions());
}

/** Drop saved effort when the active model no longer allows it. */
function validateAndClearInvalidEffort(): void {
  const chat = getActiveChat();
  if (chat.chatCommandVersion === 1) return;
  if (!chat.reasoningEffort) return;
  const caps = effectiveCapabilities();
  const levels = getLevelOptions();
  if (chat.reasoningEffort === 'off' && !modelUsesAlwaysOnReasoning(caps)) return;
  if (isComposerReasoningLevel(chat.reasoningEffort) && levels.includes(chat.reasoningEffort)) {
    return;
  }
  delete chat.reasoningEffort;
  touchChat(chat);
  scheduleSaveSessions();
}

function resolveDisplayEffort(levels: EffortOption[]): EffortOption | undefined {
  if (levels.length === 0) return undefined;
  const chat = getActiveChat();
  if (chat.reasoningEffort && levels.includes(chat.reasoningEffort)) {
    return chat.reasoningEffort;
  }
  const caps = effectiveCapabilities();
  const agent = resolveActiveWorkAgent(chat);
  const resolved = resolveThinkingMode({
    kind: 'work-agent',
    agentKey: agent?.id ?? null,
    chatThinkingMode: chat.thinkingMode,
  });
  const effort = resolveEffectiveReasoningEffort(chat, caps, resolved.mode);
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
}

/** Current chat reasoning, shared by the model label and its menu. */
export function getComposerReasoningState() {
  const caps = effectiveCapabilities();
  const chat = getActiveChat();
  const levels = getLevelOptions();
  const toggle = modelShowsComposerBrainToggle(caps);
  const agent = resolveActiveWorkAgent(chat);
  const resolved = resolveThinkingMode({
    kind: 'work-agent', agentKey: agent?.id ?? null, chatThinkingMode: chat.thinkingMode,
  });
  const effective = resolveEffectiveReasoningEffort(chat, caps, resolved.mode) ?? resolved.mode;
  const choices: ComposerReasoningChoice[] = [];
  if (levels.length || toggle) {
    choices.push({ value: 'inherit', label: 'Default' });
    if (toggle) choices.push({ value: 'off', label: 'Off' });
    if (levels.length) {
      choices.push(...levels.map(value => ({ value, label: formatReasoningEffortLabel(value) })));
    } else {
      choices.push({ value: 'on', label: 'On' });
    }
  }
  const label = levels.length && effective !== 'off'
    ? formatReasoningEffortLabel(resolveDisplayEffort(levels) ?? effective)
    : `Reasoning ${effective === 'off' ? 'off' : 'on'}`;
  return {
    label: choices.length && (caps?.reasoning === true || getAllowedOptions().length || chat.thinkingMode || chat.reasoningEffort) ? label : '', choices,
    selected: (chat.reasoningEffort ?? chat.thinkingMode ?? 'inherit') as ComposerReasoningChoice['value'],
    disabled: (chat.chatCommandVersion === 1 ? Boolean(managedModelReadOnlyReason(chat)) || isManagedModelBusy(chat.id) : isActiveChatStreaming()) || isComposerRecoveryBlocked(),
  };
}

/** Apply a chat override without changing the model's saved default. */
export function setComposerReasoningChoice(value: string): void {
  const state = getComposerReasoningState();
  if (state.disabled || !state.choices.some(choice => choice.value === value)) return;
  const chat = getActiveChat();
  if (chat.chatCommandVersion === 1) {
    void configureManagedChatModel(chat, managedReasoningSelection(chat, value, getLevelOptions().length > 0))
      .catch(error => showToast(String(error?.message || error), 'error')).finally(syncComposerReasoningEffortFromActiveChat);
    syncComposerReasoningEffortFromActiveChat(); return;
  }
  if (value === 'inherit') {
    const saved = chat.providerId && chat.modelId
      ? getModelReasoningDefault(encodeModelSelectKey(chat.providerId, chat.modelId)) : undefined;
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
  const caps = effectiveCapabilities();
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
  void syncComposerBrainNotesFromActiveChat();
  void syncComposerContextDocumentsFromActiveChat();
}

/** Re-run sync when streaming / recovery gates change (loop.ts). */
export function refreshComposerReasoningEffortDisabled(): void {
  syncComposerReasoningEffortFromActiveChat();
}

