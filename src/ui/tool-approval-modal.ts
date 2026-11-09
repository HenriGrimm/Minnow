/**
 * Approval card: docks above the composer (in `#toolApprovalHost`) whenever
 * the permission level decides a call needs the user.
 *
 * Layout — one glance answers "what, where, how risky":
 *   [kind icon] Headline                         1 of 3 · sub-agent
 *   detail (command / path / URL)
 *   risk chips
 *   ▸ Details (tool id, arguments, workspace)
 *   [1 Allow] [2 Allow <thing> for this chat] [3 Deny]   feedback field
 *   level footer: ✋ Manual · Change
 *
 * Keys: Enter / 1 allow, 2 allow for chat, Esc / 3 deny. Typing in the
 * feedback field and pressing Enter denies with that note for the agent.
 */

import { streaming } from '../app-state';
import { PERMISSION_LEVEL_META, type ActionKind } from '../lib/permissions.mjs';
import type { ToolApprovalDecision, ToolApprovalRequest } from '../tools/tool-approval-types';
import { pendingToolApprovalCount } from '../tools/approval-queue';
import { getActiveComposerSurface } from './composer-surface';
import { setComposerStreamingMode } from './composer-send';
import { setSidebarInputPendingForActiveChat } from './chat-item-dot';
import { createIcon, type IconName } from './icon';
import { PERMISSION_LEVEL_ICON, openPermissionMenu } from './permission-level';
import { markPreviewOccluder, unmarkPreviewOccluder } from './preview-occlusion';
import {
  resolvePromptComposerShell,
  resolveToolApprovalHost,
} from './prompt-host-resolve';
import {
  acquireUserPromptLock,
  isUserPromptLocked,
  releaseUserPromptLock,
} from './user-prompt-lock';

const KIND_ICON: Record<ActionKind, IconName> = {
  none: 'check',
  read: 'fileText',
  edit: 'edit',
  shell: 'terminal',
  git: 'gitBranch',
  app: 'grid',
  network: 'globe',
  browser: 'browser',
  integration: 'tools',
  settings: 'settings',
  unknown: 'help',
};

function digitHotkeyChoice(ev: KeyboardEvent): 1 | 2 | 3 | null {
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return null;
  const byCode: Record<string, 1 | 2 | 3> = {
    Digit1: 1, Digit2: 2, Digit3: 3, Numpad1: 1, Numpad2: 2, Numpad3: 3,
  };
  const fromCode = byCode[ev.code];
  if (fromCode !== undefined) return fromCode;
  if (ev.key === '1' || ev.key === '2' || ev.key === '3') return Number(ev.key) as 1 | 2 | 3;
  return null;
}

/** True when focus is in a text-entry control (inside or outside the card). */
function isTypingTarget(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return !(el as HTMLTextAreaElement).disabled;
  if (tag === 'INPUT') {
    const input = el as HTMLInputElement;
    if (['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden'].includes(input.type)) return false;
    return !input.disabled && !input.readOnly;
  }
  return false;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function actionButton(kbd: string, label: string, variant: 'primary' | 'secondary' | 'deny'): HTMLButtonElement {
  const btn = el('button', `tool-approval-action tool-approval-action--${variant}`);
  btn.type = 'button';
  btn.append(el('span', 'tool-approval-action__kbd', kbd), el('span', 'tool-approval-action__label', label));
  btn.setAttribute('aria-keyshortcuts', kbd);
  return btn;
}

/**
 * Render the approval card and resolve with the user's decision.
 * Never rejects: a missing host or an aborted signal resolves as a denial.
 */
export function showToolApprovalModal(request: ToolApprovalRequest): Promise<ToolApprovalDecision> {
  return new Promise((resolve) => {
    if (request.signal?.aborted) {
      resolve({ kind: 'deny' });
      return;
    }
    const resolvedHost = resolveToolApprovalHost();
    if (!resolvedHost) {
      resolve({ kind: 'deny' });
      return;
    }
    const host: HTMLElement = resolvedHost;

    const composerShell = resolvePromptComposerShell();
    const { inputEl: msgInput, sendBtnEl: sendBtn } = getActiveComposerSurface();
    const prevInputDisabled = msgInput?.disabled ?? false;
    const prevSendDisabled = sendBtn?.disabled ?? false;
    acquireUserPromptLock();

    composerShell?.classList.add('main-column--tool-approval-pending');
    host.hidden = false;
    host.replaceChildren();
    markPreviewOccluder(host, 'panel');

    const action = request.action;
    const risk = action?.risk ?? 'elevated';
    const panel = el('div', `tool-approval-panel tool-approval-panel--${risk}`);
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-labelledby', 'tool-approval-title');
    panel.setAttribute('aria-describedby', 'tool-approval-detail');

    // ── Header ──
    const header = el('div', 'tool-approval-panel__header');
    const kindIcon = el('span', 'tool-approval-kind');
    kindIcon.appendChild(createIcon(KIND_ICON[action?.kind ?? 'unknown']));
    const heading = el('h2', 'tool-approval-panel__title', request.title);
    heading.id = 'tool-approval-title';
    const meta = el('div', 'tool-approval-panel__meta');
    if (request.agentLabel?.trim()) {
      meta.appendChild(el('span', 'tool-approval-badge', request.agentLabel.trim()));
    }
    const counter = el('span', 'tool-approval-counter');
    meta.appendChild(counter);
    header.append(kindIcon, heading, meta);

    const syncCounter = (): void => {
      const total = pendingToolApprovalCount();
      counter.textContent = total > 1 ? `1 of ${total}` : '';
      counter.hidden = total <= 1;
    };
    syncCounter();
    const counterTimer = window.setInterval(syncCounter, 400);

    // ── Detail + chips ──
    const body = el('div', 'tool-approval-body');
    const detailText = request.description?.trim();
    if (detailText) {
      const detail = el('pre', 'tool-approval-detail', detailText);
      detail.id = 'tool-approval-detail';
      body.appendChild(detail);
    }
    const reasons = action?.reasons?.filter(Boolean) ?? [];
    if (reasons.length || risk !== 'low') {
      const chips = el('div', 'tool-approval-chips');
      if (risk !== 'low') {
        chips.appendChild(el('span', `tool-approval-chip tool-approval-chip--${risk}`, risk === 'high' ? 'High risk' : 'Needs a look'));
      }
      for (const reason of reasons) chips.appendChild(el('span', 'tool-approval-chip', reason));
      body.appendChild(chips);
    }

    const details = el('details', 'tool-approval-details');
    details.appendChild(el('summary', 'tool-approval-details__summary', 'Details'));
    const dl = el('dl', 'tool-approval-details__grid');
    const addRow = (term: string, value: string, mono = false): void => {
      dl.append(el('dt', '', term), el('dd', mono ? 'tool-approval-mono' : '', value));
    };
    addRow('Tool', request.toolName, true);
    if (request.workspace) {
      addRow('Project', 'hint' in request.workspace ? request.workspace.hint : request.workspace.path, !('hint' in request.workspace));
    }
    details.appendChild(dl);
    details.appendChild(el('pre', 'tool-approval-code', request.argsJson));
    body.appendChild(details);

    // ── Actions ──
    const actions = el('div', 'tool-approval-panel__actions');
    const btnAllow = actionButton('1', 'Allow', 'primary');
    const grant = action?.grant && action.risk !== 'high' ? action.grant : null;
    const btnChat = grant ? actionButton('2', `Allow ${grant.label} for this chat`, 'secondary') : null;
    const btnDeny = actionButton(grant ? '3' : '2', 'Deny', 'deny');
    actions.append(btnAllow, ...(btnChat ? [btnChat] : []), btnDeny);

    const feedback = el('input', 'tool-approval-feedback');
    feedback.type = 'text';
    feedback.placeholder = 'Or tell Minnow what to do instead…';
    feedback.setAttribute('aria-label', 'Deny with a note for the agent');
    feedback.autocomplete = 'off';
    feedback.spellcheck = false;

    // ── Footer: level ──
    const footer = el('div', 'tool-approval-footer');
    if (request.level) {
      const levelBtn = el('button', 'tool-approval-level');
      levelBtn.type = 'button';
      levelBtn.setAttribute('aria-haspopup', 'menu');
      levelBtn.append(
        createIcon(PERMISSION_LEVEL_ICON[request.level], { className: 'tool-approval-level__icon' }),
        el('span', '', PERMISSION_LEVEL_META[request.level].label),
        createIcon('chevronDown', { className: 'tool-approval-level__chevron' }),
      );
      levelBtn.title = 'Change the permission level';
      levelBtn.addEventListener('click', () => openPermissionMenu({ anchor: levelBtn }));
      footer.appendChild(levelBtn);
    }
    footer.appendChild(el('span', 'tool-approval-hints', grant ? '↵ allow · 2 this chat · esc deny' : '↵ allow · esc deny'));

    panel.append(header, body, actions, feedback, footer);
    host.appendChild(panel);

    let settled = false;
    const onAbort = (): void => finish({ kind: 'deny' });
    function finish(value: ToolApprovalDecision): void {
      if (settled) return;
      settled = true;
      window.clearInterval(counterTimer);
      request.signal?.removeEventListener('abort', onAbort);
      document.removeEventListener('keydown', onDocKeyDown, true);
      composerShell?.classList.remove('main-column--tool-approval-pending');
      unmarkPreviewOccluder(host);
      host.replaceChildren();
      host.hidden = true;
      setSidebarInputPendingForActiveChat(false);
      releaseUserPromptLock();
      if (!isUserPromptLocked()) {
        if (msgInput) msgInput.disabled = streaming ? false : prevInputDisabled;
        if (sendBtn) {
          if (streaming) setComposerStreamingMode('streaming');
          else sendBtn.disabled = prevSendDisabled;
        }
        msgInput?.focus();
      }
      resolve(value);
    }

    const deny = (): void => {
      const note = feedback.value.trim();
      finish(note ? { kind: 'deny', feedback: note } : { kind: 'deny' });
    };

    function onDocKeyDown(ev: KeyboardEvent): void {
      if (host.hidden) return;
      // A permission menu opened from the footer handles its own keys.
      if (document.querySelector('.permission-menu')) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        deny();
        return;
      }
      const active = document.activeElement;
      if (active === feedback) {
        if (ev.key === 'Enter' && !ev.isComposing) {
          ev.preventDefault();
          ev.stopPropagation();
          deny();
        }
        return;
      }
      if (isTypingTarget(active)) return;
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        if (active instanceof HTMLButtonElement && panel.contains(active)) return; // native click
        ev.preventDefault();
        ev.stopPropagation();
        finish({ kind: 'allow-once' });
        return;
      }
      const digit = digitHotkeyChoice(ev);
      if (digit === null) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (digit === 1) finish({ kind: 'allow-once' });
      else if (digit === 2 && btnChat) finish({ kind: 'allow-chat' });
      else deny();
    }

    btnAllow.addEventListener('click', () => finish({ kind: 'allow-once' }));
    btnChat?.addEventListener('click', () => finish({ kind: 'allow-chat' }));
    btnDeny.addEventListener('click', deny);

    request.signal?.addEventListener('abort', onAbort, { once: true });
    document.addEventListener('keydown', onDocKeyDown, true);

    requestAnimationFrame(() => {
      btnAllow.focus();
      host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  });
}
