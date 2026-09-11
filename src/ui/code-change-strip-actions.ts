import { isChatStreaming } from '../chat/streaming-state';
import { formatHistoryWithSkillTag } from '../skills/parse-slash';
import { gitLog, gitStage } from '../state/git-api';
import { isWorkspaceGitRepo } from '../state/git-workspace';
import { getActiveChat, saveSessionsNow, touchChat } from '../state/sessions';
import { getWorkspacePath } from '../state/workspace';
import type { Chat, ToolResultMessage, AssistantToolCallMessage } from '../types';
import {
  getPerFileChangeSummary,
  hasCodeChangeTotals,
} from '../usage/code-change-ledger';
import { buildHistoryUserContent } from '../chat/build-api-messages';
import { runChatTurn } from '../chat/run-turn-chat';
import { setStatus } from './status';
import { findPrimaryTurnChangesCard } from './chat-turn-changes';

const GIT_COMMIT_SKILL_ID = 'git-commit';
const CREATE_PR_SKILL_ID = 'create-pr';
const ACTIONS_HOST_ID = 'codeChangeStripActions';
const BTN_COMMIT_ID = 'btnCodeChangeCommit';
const BTN_PR_ID = 'btnCodeChangeCreatePr';
const GIT_CACHE_MS = 8_000;

let actionsHost: HTMLElement | null = null;
let commitBtn: HTMLButtonElement | null = null;
let prBtn: HTMLButtonElement | null = null;
let initialized = false;
let busy = false;
let gitCache: { path: string; isRepo: boolean; at: number } | null = null;
let syncGen = 0;

/** Git cwd for the active chat (worktree when set). */
function gitCwdForChat(chat: Chat): string | undefined {
  const worktree = chat.worktreeRoot?.trim();
  if (worktree) return worktree;
  const workspace = getWorkspacePath().trim();
  return workspace || undefined;
}

async function workspaceHasGitRepo(): Promise<boolean> {
  const path = getWorkspacePath().trim();
  const now = Date.now();
  if (gitCache && gitCache.path === path && now - gitCache.at < GIT_CACHE_MS) {
    return gitCache.isRepo;
  }
  const isRepo = await isWorkspaceGitRepo(path || undefined);
  gitCache = { path, isRepo, at: now };
  return isRepo;
}

export function invalidateCodeChangeStripActionsGitCache(): void {
  gitCache = null;
}

function gitWritesAllowed(chat: Chat): boolean {
  const modeId = chat.modeId ?? 'build';
  return modeId !== 'plan' && modeId !== 'super-plan';
}

function ensureActionButtons(): {
  host: HTMLElement | null;
  commit: HTMLButtonElement | null;
  pr: HTMLButtonElement | null;
} {
  const card = findPrimaryTurnChangesCard();
  if (!card) {
    actionsHost = null;
    commitBtn = null;
    prBtn = null;
    return { host: null, commit: null, pr: null };
  }

  const existingHost = card.querySelector(`#${ACTIONS_HOST_ID}`) as HTMLElement | null;
  const existingCommit = card.querySelector(`#${BTN_COMMIT_ID}`) as HTMLButtonElement | null;
  const existingPr = card.querySelector(`#${BTN_PR_ID}`) as HTMLButtonElement | null;
  if (existingHost && existingCommit && existingPr) {
    actionsHost = existingHost;
    commitBtn = existingCommit;
    prBtn = existingPr;
    return { host: actionsHost, commit: commitBtn, pr: prBtn };
  }

  return { host: null, commit: null, pr: null };
}

function setButtonsBusy(on: boolean): void {
  busy = on;
  if (commitBtn) {
    commitBtn.disabled = on;
    commitBtn.setAttribute('aria-disabled', on ? 'true' : 'false');
  }
  if (prBtn) {
    prBtn.disabled = on;
    prBtn.setAttribute('aria-disabled', on ? 'true' : 'false');
  }
}

function markShipHandled(chat: Chat): void {
  chat.codeChangeShipHandled = true;
  touchChat(chat);
  saveSessionsNow();
  syncCodeChangeStripActionsVisibility(chat);
}

const GITHUB_PR_URL_RE = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i;
const GIT_COMMIT_OK_RE = /^\[[^\]]+\s+[0-9a-f]{7,40}\]/i;

function toolResultLooksFailed(content: string): boolean {
  const trimmed = content.trimStart();
  const lower = trimmed.toLowerCase();
  return lower.startsWith('error') || lower.startsWith('failed');
}

function toolNameForResult(chat: Chat, toolMsg: ToolResultMessage): string | null {
  const history = chat.history;
  const idx = history.indexOf(toolMsg);
  if (idx < 0) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === 'user') break;
    if (msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls?.length) {
      const assistant = msg as AssistantToolCallMessage;
      const match = assistant.tool_calls.find((tc) => tc.id === toolMsg.tool_call_id);
      if (match) return match.function.name;
    }
  }
  return null;
}

/** Messages belonging to one strip-initiated skill turn (includes the kickoff user row). */
function forEachTurnMessage(
  chat: Chat,
  fromIndex: number,
  visit: (msg: Chat['history'][number], index: number) => void,
): void {
  for (let i = fromIndex; i < chat.history.length; i++) {
    const msg = chat.history[i];
    if (msg.role === 'user' && i > fromIndex) break;
    visit(msg, i);
  }
}

function turnTextHasPrUrl(chat: Chat, fromIndex: number): boolean {
  let found = false;
  forEachTurnMessage(chat, fromIndex, (msg) => {
    if (found) return;
    if (msg.role === 'assistant') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (GITHUB_PR_URL_RE.test(text)) found = true;
    }
    if (msg.role === 'tool') {
      const content = (msg as ToolResultMessage).content ?? '';
      if (GITHUB_PR_URL_RE.test(content) && !toolResultLooksFailed(content)) found = true;
    }
  });
  return found;
}

/** Scan tool rows after a skill turn for a successful git_commit. */
function historyHasSuccessfulGitCommit(chat: Chat, fromIndex: number): boolean {
  let found = false;
  forEachTurnMessage(chat, fromIndex, (msg) => {
    if (found || msg.role !== 'tool') return;
    const toolMsg = msg as ToolResultMessage;
    if (toolNameForResult(chat, toolMsg) !== 'git_commit') return;
    const text = toolMsg.content ?? '';
    if (toolResultLooksFailed(text)) return;
    if (GIT_COMMIT_OK_RE.test(text.trim()) || text.trim().length > 0) found = true;
  });
  return found;
}

/** Scan the turn for gh output or a pull request URL. */
function historyHasSuccessfulPr(chat: Chat, fromIndex: number): boolean {
  if (turnTextHasPrUrl(chat, fromIndex)) return true;
  let found = false;
  forEachTurnMessage(chat, fromIndex, (msg) => {
    if (found || msg.role !== 'tool') return;
    const toolMsg = msg as ToolResultMessage;
    const name = toolNameForResult(chat, toolMsg) ?? '';
    if (name !== 'execute_command' && name !== 'start_background_command') return;
    const text = toolMsg.content ?? '';
    if (toolResultLooksFailed(text)) return;
    if (/gh\s+pr\s+/i.test(text) || GITHUB_PR_URL_RE.test(text)) found = true;
  });
  return found;
}

async function headSha(cwd: string | undefined): Promise<string | null> {
  const log = await gitLog({ cwd, count: 1 });
  if (!log.ok || !log.commits?.length) return null;
  return log.commits[0].hash ?? null;
}

async function runSkillTurn(
  chat: Chat,
  skillId: string,
  userText: string,
): Promise<{ ok: boolean; historyStart: number }> {
  const historyStart = chat.history.length;
  const displayText = formatHistoryWithSkillTag(userText, skillId);
  const historyContent = buildHistoryUserContent(displayText, []);
  await runChatTurn({
    chat,
    pushUser: true,
    rawText: `/${skillId} ${userText}`,
    userText,
    skillId,
    displayText,
    historyContent,
    validAttachments: [],
    titleSeed: userText,
    shouldScheduleTitle: false,
    skillBody: null,
    ownsGlobalStreaming: chat.id === getActiveChat().id,
  });
  return { ok: true, historyStart };
}

async function onCommitClick(): Promise<void> {
  const chat = getActiveChat();
  if (busy || isChatStreaming(chat.id)) {
    setStatus('spin', 'Wait for the current turn to finish');
    return;
  }
  if (chat.codeChangeShipHandled) return;
  if (!gitWritesAllowed(chat)) {
    setStatus('err', 'Commit is not available in Plan mode');
    return;
  }
  if (!(await workspaceHasGitRepo())) {
    setStatus('err', 'This workspace is not a git repository');
    syncCodeChangeStripActionsVisibility(chat);
    return;
  }

  const paths = getPerFileChangeSummary(chat).map((row) => row.path);
  if (paths.length === 0) {
    setStatus('err', 'No file paths recorded for this chat');
    return;
  }

  setButtonsBusy(true);
  setStatus('spin', 'Staging chat changes…');

  const cwd = gitCwdForChat(chat);
  const stageRes = await gitStage({ paths, cwd });
  if (!stageRes.ok) {
    setStatus('err', stageRes.error ?? 'Could not stage files');
    setButtonsBusy(false);
    return;
  }
  if (stageRes.stagedPaths && stageRes.stagedPaths.length === 0) {
    setStatus('err', 'No files from this chat still exist to commit');
    setButtonsBusy(false);
    return;
  }

  setStatus('spin', 'Committing with git-commit skill…');
  const userText =
    'The files touched in this chat are already staged. Inspect the staged diff, then commit with a conventional commit message (use gitmoji when this repo uses them).';
  const headBefore = await headSha(cwd);
  try {
    const { historyStart } = await runSkillTurn(chat, GIT_COMMIT_SKILL_ID, userText);
    const headAfter = await headSha(cwd);
    const committed =
      historyHasSuccessfulGitCommit(chat, historyStart) ||
      (headBefore && headAfter && headBefore !== headAfter);
    if (committed) {
      markShipHandled(chat);
      setStatus('ok', 'Committed chat changes');
    } else {
      setStatus('err', 'Commit did not complete — check the assistant reply');
    }
  } catch (err) {
    setStatus('err', err instanceof Error ? err.message : 'Commit failed');
  } finally {
    setButtonsBusy(false);
    syncCodeChangeStripActionsVisibility(chat);
  }
}

async function onCreatePrClick(): Promise<void> {
  const chat = getActiveChat();
  if (busy || isChatStreaming(chat.id)) {
    setStatus('spin', 'Wait for the current turn to finish');
    return;
  }
  if (chat.codeChangeShipHandled) return;
  if (!gitWritesAllowed(chat)) {
    setStatus('err', 'Create PR is not available in Plan mode');
    return;
  }
  if (!(await workspaceHasGitRepo())) {
    setStatus('err', 'This workspace is not a git repository');
    syncCodeChangeStripActionsVisibility(chat);
    return;
  }

  setButtonsBusy(true);
  setStatus('spin', 'Creating pull request…');
  const userText =
    'Push the current branch if needed, then open a GitHub pull request for the work in this chat. Summarize why in the PR body.';
  try {
    const { historyStart } = await runSkillTurn(chat, CREATE_PR_SKILL_ID, userText);
    if (historyHasSuccessfulPr(chat, historyStart)) {
      markShipHandled(chat);
      setStatus('ok', 'Pull request created');
    } else {
      setStatus('err', 'PR was not created — check the assistant reply');
    }
  } catch (err) {
    setStatus('err', err instanceof Error ? err.message : 'Create PR failed');
  } finally {
    setButtonsBusy(false);
    syncCodeChangeStripActionsVisibility(chat);
  }
}

function wireActionButtons(): void {
  const { commit, pr } = ensureActionButtons();
  if (!commit || !pr) return;
  if (commit.dataset.stripActionBound === '1') return;
  commit.dataset.stripActionBound = '1';
  pr.dataset.stripActionBound = '1';
  commit.addEventListener('click', () => void onCommitClick());
  pr.addEventListener('click', () => void onCreatePrClick());
}

/** Show Commit / Create PR when the primary turn card exists, git is available, and not yet shipped. */
export function syncCodeChangeStripActionsVisibility(chat?: Chat | null): void {
  const gen = ++syncGen;
  wireActionButtons();
  const { host, commit, pr } = ensureActionButtons();
  if (!host || !commit || !pr) return;

  const active = chat ?? getActiveChat();
  const totals = active?.codeChangeTotals;
  const showStats =
    active &&
    hasCodeChangeTotals(totals) &&
    totals &&
    Boolean(findPrimaryTurnChangesCard());

  void (async () => {
    const hasGit = await workspaceHasGitRepo();
    if (gen !== syncGen) return;

    const allowed = active ? gitWritesAllowed(active) : false;
    const handled = Boolean(active?.codeChangeShipHandled);
    const visible = Boolean(showStats && hasGit && allowed && !handled && !busy);

    host.hidden = !visible;
    commit.hidden = !visible;
    pr.hidden = !visible;
    if (!visible) {
      commit.disabled = true;
      pr.disabled = true;
      return;
    }
    commit.disabled = busy;
    pr.disabled = busy;
    commit.setAttribute('aria-disabled', busy ? 'true' : 'false');
    pr.setAttribute('aria-disabled', busy ? 'true' : 'false');
  })();
}

/** Wire turn-change action buttons once at boot. */
export function initCodeChangeStripActions(): void {
  if (initialized) {
    syncCodeChangeStripActionsVisibility();
    return;
  }
  initialized = true;
  wireActionButtons();
  syncCodeChangeStripActionsVisibility();
}
