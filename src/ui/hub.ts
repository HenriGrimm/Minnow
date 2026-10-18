import '../styles/hub.css';

import { EMPTY_STATE_HTML } from '../constants';
import { modelCache } from '../api/models';
import { isLocalServerAvailable } from '../tools/config';
import { getWorkspaceLabel, getWorkspacePath } from '../state/workspace';
import { getChatsForWorkspace } from '../state/session-workspace-scope';
import { sessionState } from '../state/sessions';
import type { Chat } from '../types';
import { formatCompactCount } from '../usage/format-compact-count';
import { syncModeSelectorFromActiveChat } from './mode-selector';
import { createCodeReadinessActions } from './code-readiness-actions';
import { updateWorkspaceCodeChangeDisplay } from './workspace-code-change';
import {
  initHubDevServer,
  teardownHubDevServer,
  updateHubDevServer,
} from './hub-dev-server';
import { teardownOrchestrateHub } from './orchestrate-hub';
import {
  isOrchestratePlanScreenSuspendedForChat,
  teardownOrchestratePlanScreen,
} from './orchestrate-plan-screen';

export const HUB_ROOT_ID = 'vibeHub';

let hubChatId: string | null = null;
let composerRestoreParent: HTMLElement | null = null;
let composerRestoreNext: ChildNode | null = null;

let locCache: { lines: number | null; files: number | null } = { lines: null, files: null };
let vramCache: { available: boolean; usedMb?: number; totalMb?: number } = { available: false };

/** True when the hub DOM is mounted in #chatArea. */
export function isHubMounted(): boolean {
  return Boolean(document.getElementById(HUB_ROOT_ID));
}

/** Keep suspended plan-screen session when empty chat would open Vibe hub. */
function shouldPreservePlanScreenSession(chat: Chat): boolean {
  return isOrchestratePlanScreenSuspendedForChat(chat);
}

/** Remove hub chrome and restore the bottom composer. */
export function teardownHub(): void {
  teardownHubDevServer();
  restoreComposer();
  const root = document.getElementById(HUB_ROOT_ID);
  if (root) root.remove();
  document.getElementById('chatArea')?.classList.remove('chat-area--hub');
  hubChatId = null;
}

function relocateComposerIntoHub(slot: HTMLElement): void {
  const bar = document.querySelector('.input-bar') as HTMLElement | null;
  if (!bar) return;
  if (!composerRestoreParent) {
    composerRestoreParent = bar.parentElement;
    composerRestoreNext = bar.nextSibling;
  }
  slot.appendChild(bar);
  bar.classList.add('input-bar--hub');
  document.getElementById('mainColumn')?.classList.add('main-column--hub');
  syncModeSelectorFromActiveChat();
  const input = document.getElementById('msgInput') as HTMLTextAreaElement | null;
  if (input) {
    input.placeholder = 'Tell Minnow what you want to build…';
  }
}

function restoreComposer(): void {
  const bar = document.querySelector('.input-bar') as HTMLElement | null;
  if (!bar || !composerRestoreParent) return;
  if (composerRestoreNext) {
    composerRestoreParent.insertBefore(bar, composerRestoreNext);
  } else {
    composerRestoreParent.appendChild(bar);
  }
  bar.classList.remove('input-bar--hub');
  document.getElementById('mainColumn')?.classList.remove('main-column--hub');
  syncModeSelectorFromActiveChat();
  const input = document.getElementById('msgInput') as HTMLTextAreaElement | null;
  if (input) {
    input.placeholder = 'Ask Minnow to plan, build, or debug…';
  }
  composerRestoreParent = null;
  composerRestoreNext = null;
}

function getSelectedModelLabel(): string {
  const sel = document.getElementById('modelSelect') as HTMLSelectElement | null;
  if (!sel?.value) return 'no model';
  const opt = sel.selectedOptions[0];
  if (opt?.textContent?.trim()) return opt.textContent.trim();
  const cached = modelCache.get(sel.value);
  if (cached?.id) return cached.id;
  return sel.value;
}

function buildAmbientStatusLine(): string {
  const model = getSelectedModelLabel();
  const tpsEl = document.getElementById('stripTPS');
  const tpsRaw = tpsEl?.textContent?.trim() ?? '—';
  const parts = [model];
  if (tpsRaw && tpsRaw !== '—') {
    parts.push(`${tpsRaw} tok/s`);
  }
  if (vramCache.available && vramCache.totalMb != null && vramCache.usedMb != null) {
    const usedGb = (vramCache.usedMb / 1024).toFixed(1);
    const totalGb = (vramCache.totalMb / 1024).toFixed(0);
    parts.push(`vram ${usedGb}/${totalGb}gb`);
  }
  return parts.join(' · ');
}

function sumWorkspaceTokens(workspacePath: string): number {
  if (!sessionState) return 0;
  const chats = getChatsForWorkspace(workspacePath, sessionState);
  return chats.reduce((sum, chat) => sum + (chat.tokenLedger?.totals?.totalTokens ?? 0), 0);
}

async function fetchHubServerMetrics(): Promise<void> {
  if (!isLocalServerAvailable()) {
    locCache = { lines: null, files: null };
    vramCache = { available: false };
    return;
  }
  try {
    const [locRes, vramRes] = await Promise.all([
      fetch('/api/workspace/loc', { cache: 'no-store' }),
      fetch('/api/system/vram', { cache: 'no-store' }),
    ]);
    if (locRes.ok) {
      const locJson = (await locRes.json()) as {
        ok?: boolean;
        lines?: number;
        files?: number;
      };
      locCache =
        locJson.ok && typeof locJson.lines === 'number'
          ? { lines: locJson.lines, files: locJson.files ?? null }
          : { lines: null, files: null };
    } else {
      locCache = { lines: null, files: null };
    }
    if (vramRes.ok) {
      const vramJson = (await vramRes.json()) as {
        available?: boolean;
        usedMb?: number;
        totalMb?: number;
      };
      vramCache = vramJson.available
        ? {
            available: true,
            usedMb: vramJson.usedMb,
            totalMb: vramJson.totalMb,
          }
        : { available: false };
    } else {
      vramCache = { available: false };
    }
  } catch {
    locCache = { lines: null, files: null };
    vramCache = { available: false };
  }
}

function updateHubDom(activeChat: Chat): void {
  const statusEl = document.querySelector('.hub-status__text');
  if (statusEl) {
    statusEl.textContent = buildAmbientStatusLine();
  }

  const label = getWorkspaceLabel().trim();
  const heading = document.querySelector('.hub-heading');
  if (heading) {
    if (label) {
      heading.innerHTML = `Let's work on <span class="hub-heading__accent"></span>.`;
      const accent = heading.querySelector('.hub-heading__accent');
      if (accent) accent.textContent = label;
    } else {
      heading.textContent = "Let's build something.";
    }
  }

  const locEl = document.getElementById('hubLocValue');
  if (locEl) {
    locEl.textContent =
      locCache.lines != null ? formatCompactCount(locCache.lines) : '—';
  }

  updateWorkspaceCodeChangeDisplay();

  const sessionsEl = document.getElementById('hubSessionsValue');
  if (sessionsEl && sessionState) {
    const count = getChatsForWorkspace(getWorkspacePath(), sessionState).length;
    sessionsEl.textContent = String(count);
  }

  const tokensEl = document.getElementById('hubTokensValue');
  if (tokensEl) {
    const total = sumWorkspaceTokens(getWorkspacePath());
    tokensEl.textContent = formatCompactCount(total);
  }

  updateHubDevServer();

}

function buildHubDom(activeChat: Chat): HTMLElement {
  const root = document.createElement('div');
  root.id = HUB_ROOT_ID;
  root.className = 'hub-root';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Vibe Coding Hub');

  const inner = document.createElement('div');
  inner.className = 'hub-inner';

  const status = document.createElement('div');
  status.className = 'hub-status';
  status.innerHTML = '<span class="hub-status__text mono"></span>';

  const heading = document.createElement('h1');
  heading.className = 'hub-heading';

  const composerSlot = document.createElement('div');
  composerSlot.className = 'hub-composer-slot';
  composerSlot.id = 'hubComposerSlot';

  const strip = document.createElement('div');
  strip.className = 'hub-strip';
  strip.innerHTML = `
    <div class="hub-strip__cell hub-strip__cell--server hub-strip__cell--stopped" id="hubDevServerCell" tabindex="0" role="button" aria-label="Dev servers">
      <span class="hub-strip__dot idle" id="hubDevServerDot" aria-hidden="true"></span>
      <div class="hub-strip__server-body">
        <span class="hub-strip__label" id="hubDevServerLabel">Dev servers</span>
        <span class="hub-strip__meta" id="hubDevServerMeta">stopped</span>
      </div>
    </div>
    <div class="hub-strip__cell">
      <span class="hub-strip__label">Lines of code</span>
      <span class="hub-strip__value" id="hubLocValue">—</span>
    </div>
    <div class="hub-strip__cell">
      <span class="hub-strip__label">Agent changes</span>
      <span class="hub-strip__value hub-strip__value--accent" id="hubAgentChangesValue">—</span>
    </div>
    <div class="hub-strip__cell">
      <span class="hub-strip__label">Sessions</span>
      <span class="hub-strip__value" id="hubSessionsValue">0</span>
    </div>
    <div class="hub-strip__cell">
      <span class="hub-strip__label">Total tokens</span>
      <span class="hub-strip__value hub-strip__value--accent" id="hubTokensValue">0</span>
    </div>
  `;

  inner.append(heading, createCodeReadinessActions(), status, composerSlot, strip);
  root.appendChild(inner);

  const serverCell = strip.querySelector('#hubDevServerCell') as HTMLElement | null;
  if (serverCell) {
    initHubDevServer(serverCell, activeChat);
  }

  relocateComposerIntoHub(composerSlot);
  updateHubDom(activeChat);
  void fetchHubServerMetrics().then(() => {
    if (isHubMounted() && hubChatId === activeChat.id) {
      updateHubDom(activeChat);
    }
  });

  return root;
}

/** Paint the hub into #chatArea for an empty chat. */
export function renderHub(chat: Chat): void {
  try {
    teardownOrchestrateHub();
    if (!shouldPreservePlanScreenSession(chat)) {
      teardownOrchestratePlanScreen();
    }
    teardownHub();
    hubChatId = chat.id;
    const area = document.getElementById('chatArea');
    if (!area) return;
    area.replaceChildren();
    area.appendChild(buildHubDom(chat));
    area.classList.add('chat-area--hub');
  } catch {
    teardownHub();
    const area = document.getElementById('chatArea');
    if (!area) return;
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.id = 'emptyState';
    empty.innerHTML = EMPTY_STATE_HTML;
    area.replaceChildren(empty);
  }
}

/** Refresh live hub fields (status, strip, recent tiles). */
export function refreshHubLiveData(): void {
  if (!isHubMounted() || !hubChatId || !sessionState) return;
  const chat = sessionState.chats.find((c) => c.id === hubChatId);
  if (!chat || chat.history.length > 0) {
    teardownHub();
    return;
  }
  void fetchHubServerMetrics().then(() => {
    if (!isHubMounted() || !hubChatId) return;
    const active = sessionState?.chats.find((c) => c.id === hubChatId);
    if (active) updateHubDom(active);
  });
  const active = sessionState.chats.find((c) => c.id === hubChatId);
  if (active) updateHubDom(active);
}
