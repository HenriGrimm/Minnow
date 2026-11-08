import { getPendingAttachments } from '../attachments/store';
import { isPairedDevice } from '../api/session-token';
import { isChatTurnInProgress } from '../chat/chat-turn-guard';
import { followupSuggestionReply, sanitizeFollowupSuggestion } from '../chat/followup-suggestion';
import { isStreamDomVisible, subscribeChatStreamActivity } from '../chat/streaming-state';
import { getActiveChat, sessionState } from '../state/sessions';
import { chatReadOnlyReason, hasUnsettledAgentWork } from '../state/chat-relationships';
import type { AssistantMessage, Chat } from '../types';
import { autoResize } from './composer-auto-resize';
import { inlineComposerForInput } from './composer-inline-references';
import { getActiveComposerSurface } from './composer-surface';
import { isSkillPickerOpen } from './skill-picker';

interface SuggestionContext {
  chat: Chat;
  reply: AssistantMessage;
}

interface SuggestionDependencies {
  context: () => SuggestionContext | null;
  generate: (chat: Chat, signal: AbortSignal) => Promise<string | null>;
  delayMs?: number;
  timeoutMs?: number;
}

function responseKey(context: SuggestionContext | null): string | null {
  return context ? JSON.stringify([context.chat.id, context.chat.history.length, context.reply.content]) : null;
}

/** The ghost is presentation only. Text enters the ordinary draft path on acceptance. */
export class ComposerFollowupSuggestion {
  private context: SuggestionContext | null = null;
  private results = new Map<string, string | null>();
  private key: string | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ghost: HTMLDivElement | null = null;
  private text: string | null = null;

  constructor(private input: HTMLTextAreaElement, private deps: SuggestionDependencies) {
    input.addEventListener('input', () => this.dismiss());
    input.addEventListener('compositionstart', () => this.dismiss());
    input.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || isSkillPickerOpen()) return;
      if (event.key === 'Escape') {
        if (this.text) event.preventDefault();
        this.dismiss();
      } else if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (this.accept()) event.preventDefault();
      }
    });
    new input.ownerDocument.defaultView!.MutationObserver(() => {
      if (input.disabled || input.readOnly) this.dismiss();
    }).observe(input, { attributes: true, attributeFilter: ['disabled', 'readonly'] });
  }

  sync(): void {
    const next = this.deps.context();
    const key = responseKey(next);
    if (!this.input.isConnected || this.input.disabled || this.input.readOnly || this.input.value !== '') {
      this.dismiss();
      return;
    }
    if (key === this.key) return;
    this.cancel();
    this.context = next;
    this.key = key;
    this.paint(null);
    if (!next || !key) return;
    if (this.results.has(key)) {
      this.paint(this.results.get(key) ?? null);
      return;
    }
    this.results.set(key, null);
    if (this.results.size > 32) this.results.delete(this.results.keys().next().value!);
    const controller = new AbortController();
    this.controller = controller;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.isCurrent(next)) { this.cancel(); return; }
      const timeout = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? 20_000);
      void this.deps.generate(next.chat, controller.signal).then(raw => {
        if (controller.signal.aborted || !this.isCurrent(next)) return;
        const text = raw ? sanitizeFollowupSuggestion(raw) : null;
        this.results.set(key, text);
        this.paint(text);
      }).catch(() => {}).finally(() => {
        clearTimeout(timeout);
        if (this.controller === controller) this.controller = null;
      });
    }, this.deps.delayMs ?? 600);
  }

  private isCurrent(context: SuggestionContext): boolean {
    return this.context === context && responseKey(this.deps.context()) === this.key &&
      this.input.isConnected && !this.input.disabled && !this.input.readOnly && this.input.value === '';
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
  }

  dismiss(): void {
    if (this.key) this.results.set(this.key, null);
    this.cancel();
    this.paint(null);
  }

  accept(): boolean {
    if (!this.text || !this.context || !this.isCurrent(this.context)) {
      this.paint(null);
      return false;
    }
    const text = this.text;
    this.dismiss();
    this.input.value = text;
    this.input.setSelectionRange(text.length, text.length);
    this.input.dispatchEvent(new this.input.ownerDocument.defaultView!.Event('input', { bubbles: true }));
    autoResize(this.input);
    this.input.focus();
    return true;
  }

  private paint(text: string | null): void {
    this.text = text;
    if (!text) {
      this.ghost?.remove();
      this.ghost = null;
      this.input.parentElement?.classList.remove('has-followup-suggestion');
      return;
    }
    let host = this.input.parentElement;
    if (!host) return;
    if (!host.classList.contains('composer-skill-highlight-host')) {
      const wrapper = this.input.ownerDocument.createElement('div');
      wrapper.className = 'composer-skill-highlight-host';
      this.input.before(wrapper);
      wrapper.append(this.input);
      host = wrapper;
    }
    const ghost = this.input.ownerDocument.createElement('div');
    ghost.className = 'composer-followup-suggestion';
    const announcement = this.input.ownerDocument.createElement('span');
    announcement.className = 'visually-hidden';
    announcement.setAttribute('role', 'status');
    announcement.textContent = `Suggested follow-up: ${text} Press Tab to use or Escape to dismiss.`;
    const visibleInput = inlineComposerForInput(this.input) ?? this.input;
    const style = this.input.ownerDocument.defaultView!.getComputedStyle(visibleInput);
    for (const property of ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'padding']) {
      ghost.style.setProperty(property, style.getPropertyValue(property));
    }
    const label = this.input.ownerDocument.createElement('span');
    label.className = 'composer-followup-suggestion__text';
    label.textContent = text;
    label.setAttribute('aria-hidden', 'true');
    const accept = this.input.ownerDocument.createElement('button');
    accept.type = 'button';
    accept.className = 'composer-followup-suggestion__accept';
    accept.textContent = 'Tab';
    accept.tabIndex = -1;
    accept.setAttribute('aria-label', `Use suggested follow-up: ${text}`);
    accept.title = `${text}\nTab to use · Escape to dismiss`;
    accept.addEventListener('mousedown', event => event.preventDefault());
    accept.addEventListener('click', () => this.accept());
    ghost.append(announcement, label, accept);
    this.ghost?.remove();
    this.ghost = ghost;
    host.classList.add('has-followup-suggestion');
    host.append(ghost);
  }
}

const bindings = new WeakMap<HTMLTextAreaElement, ComposerFollowupSuggestion>();
let active: ComposerFollowupSuggestion | null = null;
let subscribed = false;

/** Sync on chat switches and stream transitions, including managed conversation updates. */
export function syncComposerFollowupSuggestion(): void {
  if (!sessionState) { active?.sync(); return; }
  const surface = getActiveComposerSurface();
  const input = surface.inputEl;
  const binding = input ? bindings.get(input) : null;
  if (active !== binding) active?.dismiss();
  active = binding ?? null;
  active?.sync();
}

export function initComposerFollowupSuggestion(input: HTMLTextAreaElement): void {
  if (bindings.has(input)) return;
  const binding = new ComposerFollowupSuggestion(input, {
    context: () => {
      if (!sessionState || isPairedDevice()) return null;
      const surface = getActiveComposerSurface();
      if (surface.inputEl !== input || surface.onPrimaryAction) return null;
      const chat = getActiveChat();
      if (!isStreamDomVisible(chat.id) || isChatTurnInProgress(chat.id) || hasUnsettledAgentWork(chat) ||
        chatReadOnlyReason(chat) || (chat.activeGoal && !chat.activeGoal.achieved) ||
        chat.resumeInterrupted || chat.pendingSteerMessage || chat.pendingMessageQueue?.some(item => item.kind === 'steer') || getPendingAttachments().length) return null;
      const reply = followupSuggestionReply(chat);
      return reply ? { chat, reply } : null;
    },
    generate: async (chat, signal) => {
      const { generateFollowupSuggestion } = await import('../chat/followup-suggestion-client');
      return generateFollowupSuggestion(chat, signal);
    },
  });
  bindings.set(input, binding);
  if (!subscribed) {
    subscribed = true;
    subscribeChatStreamActivity(syncComposerFollowupSuggestion);
  }
  syncComposerFollowupSuggestion();
}
