import {
  canUndoTurn,
  getUndoEligibility,
  undoLastAgentTurn,
  UNDO_STATUS,
  undoBlockMessage,
} from '../chat/undo-turn';
import { createIcon } from './icon';
import { isWorkspaceGitRepo } from '../state/git-workspace';
import { findRunById } from '../state/runs-store';
import { getActiveChat } from '../state/sessions';
import { getWorkspacePath } from '../state/workspace';
import { runHadCodeChanges } from '../usage/code-change-ledger';
import { renderChatFromHistory, renderStatsForChat } from './messages';
import { renderSidebar } from './sidebar';
import { setStatus } from './status';
import { findPrimaryTurnChangesCard } from './chat-turn-changes';

const TITLE_ENABLED = 'Undo last agent turn';
/** Prefer the turn-changes id; keep legacy id as a fallback for older DOM. */
const UNDO_BUTTON_IDS = ['btnCodeChangeUndo', 'btnComposerUndo'] as const;
/** Avoid hammering /api/workspace/git-status on every sidebar re-render. */
const GIT_CACHE_MS = 8_000;

let btnEl: HTMLButtonElement | null = null;
let gitCache: { path: string; isRepo: boolean; at: number } | null = null;
/** Monotonic token so overlapping async syncs don't apply stale visibility. */
let syncGen = 0;

// ── Button ───────────────────────────────────────────────────────────────────

function findExistingButton(): HTMLButtonElement | null {
  const card = findPrimaryTurnChangesCard();
  if (card) {
    const inCard = card.querySelector(`#${UNDO_BUTTON_IDS[0]}`) as HTMLButtonElement | null;
    if (inCard) return inCard;
  }
  for (const id of UNDO_BUTTON_IDS) {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el) return el;
  }
  return null;
}

/** Static markup may ship a placeholder span; inject the Uicons glyph if missing. */
function ensureUndoIcon(btn: HTMLButtonElement): void {
  if (btn.querySelector('.chat-turn-changes__undo-icon.fi, .code-change-strip__undo-icon.fi')) return;
  const placeholder = btn.querySelector('.chat-turn-changes__undo-icon, .code-change-strip__undo-icon');
  const icon = createIcon('undo', { className: 'chat-turn-changes__undo-icon', size: 14 });
  if (placeholder) placeholder.replaceWith(icon);
  else btn.appendChild(icon);
}

/** Ensure the undo control exists on the primary turn-changes card (idempotent). */
function ensureButton(): HTMLButtonElement | null {
  if (btnEl?.isConnected) return btnEl;
  const existing = findExistingButton();
  if (existing) {
    ensureUndoIcon(existing);
    btnEl = existing;
    return btnEl;
  }
  return null;
}

/** Tooltip / aria when disabled — prefer eligibility message, then reason fallback. */
function disabledHint(eligibility: ReturnType<typeof getUndoEligibility>): string {
  if (eligibility.message?.trim()) return eligibility.message;
  if (eligibility.reason) return undoBlockMessage(eligibility.reason);
  return 'Undo unavailable';
}

/** Cached workspace git check; path change or TTL expiry refetches. */
async function workspaceHasGitRepo(): Promise<boolean> {
  const path = getWorkspacePath().trim();
  const now = Date.now();
  if (
    gitCache &&
    gitCache.path === path &&
    now - gitCache.at < GIT_CACHE_MS
  ) {
    return gitCache.isRepo;
  }
  const isRepo = await isWorkspaceGitRepo(path || undefined);
  gitCache = { path, isRepo, at: now };
  return isRepo;
}

/** Drop cache after workspace switch / git init so the next sync rechecks. */
export function invalidateComposerUndoGitCache(): void {
  gitCache = null;
}

// ── Click ────────────────────────────────────────────────────────────────────

async function onUndoClick(): Promise<void> {
  const chat = getActiveChat();
  if (!(await workspaceHasGitRepo())) {
    setStatus('err', 'Undo needs a git repository in this workspace');
    syncComposerUndoFromActiveChat();
    return;
  }

  const eligibility = getUndoEligibility(chat);
  if (!eligibility.ok) {
    setStatus('err', eligibility.message ?? 'Undo unavailable');
    return;
  }

  const result = await undoLastAgentTurn(chat.id);
  if (!result.ok) {
    if (result.error === 'cancelled') {
      setStatus('ok', UNDO_STATUS.cancelled);
      syncComposerUndoFromActiveChat();
      return;
    }
    const msg =
      result.error === 'streaming'
        ? undoBlockMessage('streaming')
        : UNDO_STATUS.failed;
    setStatus(result.error === 'streaming' ? 'spin' : 'err', msg);
    syncComposerUndoFromActiveChat();
    return;
  }

  const updated = getActiveChat();
  renderChatFromHistory(updated);
  renderStatsForChat(updated);
  renderSidebar();
  syncComposerUndoFromActiveChat();

  const input = document.getElementById('msgInput') as HTMLTextAreaElement | null;
  input?.focus();

  setStatus(
    'ok',
    result.filesRestored ? UNDO_STATUS.successFiles : UNDO_STATUS.successChat,
  );
}

// ── Sync ─────────────────────────────────────────────────────────────────────

/** Wire the turn-changes Undo control (idempotent). */
export function initComposerUndo(): void {
  const btn = ensureButton();
  if (!btn || btn.dataset.undoBound === '1') {
    syncComposerUndoFromActiveChat();
    return;
  }
  btn.dataset.undoBound = '1';
  btn.addEventListener('click', () => {
    void onUndoClick();
  });
  syncComposerUndoFromActiveChat();
}

/** Refresh visibility / disabled state from the active chat. */
export function syncComposerUndoFromActiveChat(): void {
  btnEl = null;
  const btn = ensureButton();
  if (!btn) return;

  const gen = ++syncGen;
  void (async () => {
    const hasGit = await workspaceHasGitRepo();
    if (gen !== syncGen) return;

    const chat = getActiveChat();
    const eligibility = getUndoEligibility(chat);
    const target = eligibility.target;
    const run = target ? findRunById(chat, target.runId) : undefined;
    const targetChangedFiles =
      target && run ? runHadCodeChanges(chat, run) : false;

    if (!hasGit || !targetChangedFiles) {
      btn.hidden = true;
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
      btn.dataset.undoReason = !hasGit ? 'no_git' : 'no_file_changes';
      return;
    }

    btn.hidden = false;

    const enabled = eligibility.ok && canUndoTurn(chat);
    btn.disabled = !enabled;

    const hint = enabled ? TITLE_ENABLED : disabledHint(eligibility);

    btn.title = hint;
    btn.setAttribute('aria-label', hint);
    btn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    btn.dataset.undoReason = eligibility.reason ?? '';
  })();
}

/** Re-sync when streaming / chat switches (loop + sidebar). */
export function refreshComposerUndoDisabled(): void {
  syncComposerUndoFromActiveChat();
}
