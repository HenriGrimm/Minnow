import { resolveThinkingMode, resolveThinkingBudgetTokens } from '../agents/resolve-thinking';
import {
  formatThinkingInheritedLabel,
  modelAllowsThinkingMode,
  modelSupportsThinkingControl,
} from '../agents/thinking-capabilities';
import {
  normalizeThinkingTriState,
  type ThinkingResolvedMode,
  type ThinkingTriState,
} from '../agents/thinking-types';
import { isActiveChatStreaming } from '../chat/streaming-state';
import {
  defaultComposerReasoningLevel,
  isComposerReasoningLevel,
  modelShowsComposerBrainToggle,
  modelUsesAlwaysOnReasoning,
  modelUsesComposerReasoningDropdown,
  modelUsesComposerThinkingToggle,
  resolveEffectiveReasoningEffort,
} from '../lib/reasoning-effort';
import { resolveSendCapabilities } from '../providers/model-capabilities';
import { resolveActiveWorkAgent } from '../agents/resolve-work-agent';
import {
  ensureSessionsReady,
  getActiveChat,
  scheduleSaveSessions,
  sessionState,
  touchChat,
} from '../state/sessions';
import { syncComposerReasoningEffortFromActiveChat, setComposerReasoningChoice } from './composer-reasoning-effort';
import { createIcon } from './icon';
import { isComposerRecoveryBlocked } from './composer-send';
import { configureManagedChatModel, isManagedModelBusy, managedModelReadOnlyReason, managedReasoningSelection } from './managed-chat-model';
import { showToast } from './toast';

let rootEl: HTMLElement | null = null;
let toggleBtn: HTMLButtonElement | null = null;

// ── State ────────────────────────────────────────────────────────────────────

/** Next tri-state after a composer click: inherit → opposite of resolved → toggle → inherit. */
export function nextThinkingTriStateOnClick(
  tri: ThinkingTriState,
  resolved: ThinkingResolvedMode,
): ThinkingTriState {
  if (tri === 'inherit') return resolved === 'on' ? 'off' : 'on';
  if (tri === 'on') return 'off';
  return 'inherit';
}

function formatBudgetHint(budget: ReturnType<typeof resolveThinkingBudgetTokens>): string {
  if (budget.budgetTokens == null || budget.budgetTokens <= 0) return '';
  const k =
    budget.budgetTokens >= 1000
      ? `${Math.round(budget.budgetTokens / 1000)}k`
      : String(budget.budgetTokens);
  return ` · budget: ${k} (${budget.sourceLabel})`;
}

function effectiveCapabilities(): ReturnType<typeof resolveSendCapabilities> {
  if (!sessionState) return undefined;
  const chat = getActiveChat();
  const modelId = chat.modelId?.trim();
  const providerId = chat.providerId?.trim();
  if (!modelId || !providerId) return undefined;
  return resolveSendCapabilities(providerId, modelId);
}

function isDropdownReasoningActive(
  caps: ReturnType<typeof resolveSendCapabilities>,
): boolean {
  const chat = getActiveChat();
  if (chat.reasoningEffort === 'off') return false;
  if (isComposerReasoningLevel(chat.reasoningEffort)) {
    return true;
  }
  const agent = resolveActiveWorkAgent(chat);
  const resolved = resolveThinkingMode({
    kind: 'work-agent',
    agentKey: agent?.id ?? null,
    chatThinkingMode: chat.thinkingMode,
  });
  const effort = resolveEffectiveReasoningEffort(chat, caps, resolved.mode);
  return effort !== 'off' && effort !== undefined;
}

function applyChatThinkingMode(mode: ThinkingTriState): void {
  const chat = getActiveChat();
  if (chat.chatCommandVersion === 1) {
    void configureManagedChatModel(chat, managedReasoningSelection(chat, mode, false))
      .catch(error => showToast(String(error?.message || error), 'error')).finally(syncComposerReasoningEffortFromActiveChat);
    syncComposerReasoningEffortFromActiveChat(); return;
  }
  if (mode === 'inherit') {
    delete chat.thinkingMode;
  } else {
    chat.thinkingMode = mode;
  }
  touchChat(chat);
  scheduleSaveSessions();
  syncThinkingControlFromActiveChat();
}

/** Toggle reasoning off/on for models that use the level dropdown + brain combo. */
function applyDropdownModeBrainToggle(): void {
  const chat = getActiveChat();
  const caps = effectiveCapabilities();
  if (modelUsesAlwaysOnReasoning(caps)) return;
  if (chat.chatCommandVersion === 1) {
    setComposerReasoningChoice(chat.reasoningEffort === 'off' ? defaultComposerReasoningLevel(caps) ?? 'inherit' : 'off');
    return;
  }
  if (chat.reasoningEffort === 'off') {
    const level = defaultComposerReasoningLevel(caps);
    if (level) chat.reasoningEffort = level;
    else delete chat.reasoningEffort;
  } else {
    chat.reasoningEffort = 'off';
  }
  touchChat(chat);
  scheduleSaveSessions();
  syncComposerReasoningEffortFromActiveChat();
}

// ── Toggle ───────────────────────────────────────────────────────────────────

function onToggleClick(): void {
  if (toggleBtn?.disabled) return;
  const caps = effectiveCapabilities();
  if (modelUsesComposerReasoningDropdown(caps)) {
    applyDropdownModeBrainToggle();
    return;
  }

  const chat = getActiveChat();
  const tri = normalizeThinkingTriState(chat.thinkingMode, 'inherit');
  const agent = resolveActiveWorkAgent(chat);
  const resolved = resolveThinkingMode({
    kind: 'work-agent',
    agentKey: agent?.id ?? null,
    chatThinkingMode: chat.thinkingMode,
  });
  applyChatThinkingMode(nextThinkingTriStateOnClick(tri, resolved.mode));
}

/** Mount reasoning toggle into #composerThinkingControl. */
export function initThinkingControl(): void {
  rootEl = document.getElementById('composerThinkingControl');
  if (!rootEl) return;

  rootEl.innerHTML = '';
  rootEl.className = 'thinking-toggle-host';

  toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'thinking-toggle-btn';
  toggleBtn.setAttribute('aria-label', 'Reasoning');
  toggleBtn.addEventListener('click', onToggleClick);

  const icon = createIcon('reasoning', { className: 'thinking-toggle-icon' });
  toggleBtn.appendChild(icon);
  rootEl.appendChild(toggleBtn);
  void ensureSessionsReady().then(() => syncThinkingControlFromActiveChat());
}

// ── Sync ─────────────────────────────────────────────────────────────────────

/** Sync reasoning toggle from active chat, inheritance, and model capabilities. */
export function syncThinkingControlFromActiveChat(): void {
  if (!sessionState) return;
  const caps = effectiveCapabilities();
  const thinkingWrap = document.getElementById('composerThinkingWrap');
  const dropdownMode = modelUsesComposerReasoningDropdown(caps);
  const toggleMode = modelUsesComposerThinkingToggle(caps);
  const showBrain = modelShowsComposerBrainToggle(caps);
  const showWrap = showBrain || dropdownMode;

  if (thinkingWrap) {
    thinkingWrap.classList.toggle('hidden', !showWrap);
  }

  if (rootEl) {
    rootEl.classList.toggle('hidden', !showBrain);
  }

  if (!toggleBtn || !showBrain) return;

  const chat = getActiveChat();
  const disabled = (chat.chatCommandVersion === 1 ? Boolean(managedModelReadOnlyReason(chat)) || isManagedModelBusy(chat.id) : isActiveChatStreaming()) || isComposerRecoveryBlocked();

  if (dropdownMode) {
    const effectiveOn = isDropdownReasoningActive(caps);
    toggleBtn.setAttribute('aria-pressed', effectiveOn ? 'true' : 'false');
    toggleBtn.dataset.inherit = 'false';
    toggleBtn.dataset.thinkingTri = effectiveOn ? 'on' : 'off';
    toggleBtn.disabled = disabled;
    toggleBtn.title = effectiveOn
      ? 'Reasoning on — click to turn off'
      : 'Reasoning off — click to turn on';
    return;
  }

  if (!toggleMode) return;

  const tri = normalizeThinkingTriState(chat.thinkingMode, 'inherit');
  const agent = resolveActiveWorkAgent(chat);
  const resolved = resolveThinkingMode({
    kind: 'work-agent',
    agentKey: agent?.id ?? null,
    chatThinkingMode: chat.thinkingMode,
  });
  const supports = modelSupportsThinkingControl(caps);
  const effectiveOn = resolved.mode === 'on';
  const allowed = supports && modelAllowsThinkingMode(caps, resolved.mode);

  toggleBtn.setAttribute('aria-pressed', effectiveOn ? 'true' : 'false');
  toggleBtn.dataset.inherit = tri === 'inherit' ? 'true' : 'false';
  toggleBtn.dataset.thinkingTri = tri;
  toggleBtn.disabled = !allowed || disabled;

  if (!supports) {
    toggleBtn.title = 'Effective model does not advertise reasoning support';
  } else if (!allowed) {
    toggleBtn.title = `Model does not support reasoning ${resolved.mode}`;
  } else if (tri === 'inherit') {
    const budget = resolveThinkingBudgetTokens({
      kind: 'work-agent',
      agentKey: agent?.id ?? null,
    });
    toggleBtn.title =
      formatThinkingInheritedLabel(tri, resolved.mode, resolved.sourceLabel) +
      formatBudgetHint(budget);
  } else {
    toggleBtn.title = effectiveOn
      ? 'Reasoning on (chat override)'
      : 'Reasoning off (chat override)';
  }
}

export function refreshThinkingControlDisabled(): void {
  syncThinkingControlFromActiveChat();
}
