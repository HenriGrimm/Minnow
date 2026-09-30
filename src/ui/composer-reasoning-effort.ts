import { resolveThinkingMode } from '../agents/resolve-thinking';
import { isActiveChatStreaming } from '../chat/streaming-state';
import {
  formatReasoningEffortLabel,
  getComposerReasoningLevelOptions,
  isComposerReasoningLevel,
  modelUsesAlwaysOnReasoning,
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
import { positionRunTargetMenu } from './composer-run-target-menu';
import { createIcon } from './icon';

let selectEl: HTMLSelectElement | null = null;
let wrapEl: HTMLElement | null = null;
let segmentsEl: HTMLElement | null = null;
/** Footer trigger + themed menu; the hidden native select stays the source of truth. */
let triggerEl: HTMLButtonElement | null = null;
let menuEl: HTMLElement | null = null;
let menuOutsideHandler: ((event: PointerEvent) => void) | null = null;
let menuEscapeHandler: ((event: KeyboardEvent) => void) | null = null;

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

/** Compact overflow uses a segmented control; the native select stays for the wide row. */
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

// ── Footer menu ──────────────────────────────────────────────────────────────

function ensureTrigger(): void {
  if (!wrapEl || !selectEl || (triggerEl && wrapEl.contains(triggerEl))) return;
  closeReasoningEffortMenu();
  menuEl?.remove();
  triggerEl = document.createElement('button');
  triggerEl.type = 'button';
  triggerEl.id = 'composerReasoningEffortBtn';
  triggerEl.className = 'composer-reasoning-effort-btn';
  triggerEl.setAttribute('aria-haspopup', 'menu');
  triggerEl.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span');
  label.className = 'composer-reasoning-effort-btn__label';
  triggerEl.append(createIcon('reasoning', { className: 'composer-reasoning-effort-btn__icon', size: 12 }), label);
  triggerEl.addEventListener('click', (event) => {
    event.stopPropagation();
    if (menuEl && !menuEl.classList.contains('hidden')) closeReasoningEffortMenu();
    else openReasoningEffortMenu();
  });
  wrapEl.insertBefore(triggerEl, selectEl);

  menuEl = document.createElement('div');
  menuEl.id = 'composerReasoningEffortMenu';
  menuEl.className = 'composer-run-target-menu composer-reasoning-effort-menu hidden';
  menuEl.setAttribute('role', 'menu');
  menuEl.setAttribute('aria-label', 'Reasoning effort');
  document.body.appendChild(menuEl);
}

function syncTrigger(): void {
  if (!triggerEl || !selectEl) return;
  const text = selectEl.options[selectEl.selectedIndex]?.textContent ?? '';
  const label = triggerEl.querySelector('.composer-reasoning-effort-btn__label');
  if (label && label.textContent !== text) label.textContent = text;
  triggerEl.disabled = selectEl.disabled;
  triggerEl.setAttribute('aria-label', `Reasoning effort, ${text}`);
  if (selectEl.disabled) closeReasoningEffortMenu();
}

function openReasoningEffortMenu(): void {
  if (!triggerEl || !menuEl || !selectEl || selectEl.disabled) return;
  menuEl.replaceChildren();
  for (const option of Array.from(selectEl.options)) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'composer-run-target-menu__item';
    item.setAttribute('role', 'menuitemradio');
    const checked = option.value === selectEl.value;
    item.setAttribute('aria-checked', String(checked));
    const text = document.createElement('span');
    text.textContent = option.textContent ?? option.value;
    item.append(text);
    if (checked) item.append(createIcon('check', { className: 'composer-reasoning-effort-menu__check', size: 12 }));
    item.addEventListener('click', () => {
      closeReasoningEffortMenu();
      if (!selectEl || selectEl.disabled || selectEl.value === option.value) return;
      selectEl.value = option.value;
      selectEl.dispatchEvent(new Event('change'));
    });
    menuEl.append(item);
  }
  menuEl.classList.remove('hidden');
  triggerEl.setAttribute('aria-expanded', 'true');
  positionRunTargetMenu(triggerEl, menuEl);
  menuEl.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();

  menuOutsideHandler = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (menuEl?.contains(target) || triggerEl?.contains(target)) return;
    closeReasoningEffortMenu();
  };
  menuEscapeHandler = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeReasoningEffortMenu();
    triggerEl?.focus();
  };
  document.addEventListener('pointerdown', menuOutsideHandler, true);
  document.addEventListener('keydown', menuEscapeHandler, true);
}

/** Close the footer effort menu (chat switch, streaming, outside click). */
export function closeReasoningEffortMenu(): void {
  menuEl?.classList.add('hidden');
  triggerEl?.setAttribute('aria-expanded', 'false');
  if (menuOutsideHandler) document.removeEventListener('pointerdown', menuOutsideHandler, true);
  if (menuEscapeHandler) document.removeEventListener('keydown', menuEscapeHandler, true);
  menuOutsideHandler = null;
  menuEscapeHandler = null;
}

function onSelectChange(): void {
  syncTrigger();
  if (!selectEl || selectEl.disabled) return;
  const levels = getLevelOptions();
  const value = selectEl.value as EffortOption;
  if (!levels.includes(value)) return;

  const chat = getActiveChat();
  chat.reasoningEffort = value;
  touchChat(chat);
  scheduleSaveSessions();
  syncThinkingControlFromActiveChat();
  void syncComposerCodeMapFromActiveChat();
  void syncComposerBrainNotesFromActiveChat();
  void syncComposerContextDocumentsFromActiveChat();
}

function isLevelDropdownVisible(): boolean {
  const caps = effectiveCapabilities();
  if (!modelUsesComposerReasoningLevelDropdown(caps)) return false;
  if (modelUsesAlwaysOnReasoning(caps)) return true;
  return getActiveChat().reasoningEffort !== 'off';
}

// ── Init ─────────────────────────────────────────────────────────────────────

/** Wire composer reasoning effort select. */
export function initComposerReasoningEffort(): void {
  selectEl = document.getElementById('composerReasoningEffortSelect') as HTMLSelectElement | null;
  wrapEl = document.getElementById('composerReasoningEffortWrap');
  segmentsEl = document.getElementById('composerReasoningEffortSegments');
  selectEl?.addEventListener('change', onSelectChange);
  segmentsEl?.addEventListener('click', onSegmentClick);
  ensureTrigger();
  syncComposerReasoningEffortFromActiveChat();
}

/** Refresh dropdown options, visibility, and disabled state. */
export function syncComposerReasoningEffortFromActiveChat(): void {
  validateAndClearInvalidEffort();

  const caps = effectiveCapabilities();
  const visible = isLevelDropdownVisible();
  const disabled = isActiveChatStreaming() || isComposerRecoveryBlocked();

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
  syncTrigger();

  syncThinkingControlFromActiveChat();
  void syncComposerCodeMapFromActiveChat();
  void syncComposerBrainNotesFromActiveChat();
  void syncComposerContextDocumentsFromActiveChat();
}

/** Re-run sync when streaming / recovery gates change (loop.ts). */
export function refreshComposerReasoningEffortDisabled(): void {
  syncComposerReasoningEffortFromActiveChat();
}

