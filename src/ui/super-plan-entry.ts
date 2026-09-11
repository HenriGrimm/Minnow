/**
 * Super Plan surface controller. Decides which chat and run the page shows,
 * owns #chatArea while it is up, and turns the page's intents into actions.
 *
 * A Super Plan chat is the home of one run: foregrounding it in Code shows the
 * run, a chat with no run shows the composer. Runs execute on the server; this
 * module never advances a pipeline.
 */

import '../styles/super-plan-page.css';
import { SUPER_PLAN_ENABLED } from '../config/super-plan-enabled';

import { notifyAskQuestionDisplayContextChanged } from '../chat/ask-question-display';
import { DEFAULT_MODE_ID, normalizeModeId } from '../chat/modes/types';
import { isChatStreaming } from '../chat/streaming-state';
import {
  cancelSuperPlan,
  deleteSuperPlanRunForChat,
  isSuperPlanPipelineResumable,
  startSuperPlan,
} from '../chat/super-plan/client';
import {
  collectSuperPlanRuns,
  isChatInCurrentWorkspace,
  isChatInWorkspace,
  type PlanLibraryEntry,
} from '../chat/super-plan/plan-library';
import { chatHasListableContent } from '../state/session-workspace-scope';
import { isReusableEmptyPlanChat } from '../chat/super-plan/spare-chat';
import { startSuperPlanBackgroundSync } from '../chat/super-plan/store';
import { deleteSuperPlanPlanFile } from '../chat/super-plan/api';
import { findChatById, removeChatById, scheduleSaveSessions, sessionState } from '../state/sessions';
import { getWorkspacePath } from '../state/workspace';
import { isLocalServerAvailable } from '../tools/config';
import type { Chat } from '../types';
import { appAlert, appChoice, appConfirm } from './app-dialog';
import { isChatAppForeground } from './chat-mount';
import { applyComposerDraftForChat, persistComposerDraftOnChat } from './composer-draft';
import { getActiveComposerSurface } from './composer-surface';
import { readDefaultModelBinding } from './default-model';
import { teardownHub } from './hub';
import { isSuperPlanChromeActive, syncSuperPlanChrome } from './super-plan-chrome';
import {
  getSuperPlanPageView,
  isSuperPlanPageMounted,
  mountSuperPlanPage,
  refreshSuperPlanLibrary,
  showSuperPlanPageView,
  teardownSuperPlanPage,
  type SuperPlanPageHandlers,
  type SuperPlanPageView,
} from './super-plan-page';
import { setStatus } from './status';

const CHAT_AREA_CLASSES = ['chat-area--plan-screen', 'chat-area--super-plan'] as const;
const MAIN_COLUMN_CLASS = 'main-column--plan-screen';

let returnChatId: string | null = null;
let initialized = false;

// ── State queries ────────────────────────────────────────────────────────────

/** True when the Super Plan surface owns the stage. */
export function isSuperPlanScreenOpen(): boolean {
  return isSuperPlanPageMounted();
}

/** True when the surface is on screen showing this run. */
export function isSuperPlanScreenShowingRun(runId: string): boolean {
  const view = getSuperPlanPageView();
  return view?.mode === 'run' && view.runId === runId;
}

/** True when the surface is on screen for this chat (its run, composer or a file opened from it). */
export function isSuperPlanScreenShowingChat(chatId: string): boolean {
  return getSuperPlanPageView()?.chatId === chatId;
}

/** True when the surface is mounted, but for some other chat. */
export function isSuperPlanScreenMountedForOtherChat(chatId: string): boolean {
  const view = getSuperPlanPageView();
  return Boolean(view && view.chatId !== chatId);
}

function isSuperPlanChat(chat: Chat | null | undefined): boolean {
  return Boolean(chat && normalizeModeId(chat.modeId) === 'super-plan');
}

function chatMatchesOpenWorkspace(chat: Chat): boolean {
  if (!getWorkspacePath()?.trim()) return true;
  return isChatInCurrentWorkspace(chat);
}

// ── Mounting ─────────────────────────────────────────────────────────────────

function viewForChat(chat: Chat): SuperPlanPageView {
  const runId = chat.superPlanRunId?.trim();
  return runId ? { mode: 'run', chatId: chat.id, runId } : { mode: 'compose', chatId: chat.id };
}

/** Put the surface in #chatArea (reusing a mounted one) and show `view`. */
function showSurface(view: SuperPlanPageView): void {
  const area = document.getElementById('chatArea');
  if (!area) return;
  const wasMounted = isSuperPlanPageMounted();
  // The hub borrows the chat composer; it must hand it back before #chatArea is replaced.
  teardownHub();
  const page = mountSuperPlanPage(area, handlers);
  area.classList.add(...CHAT_AREA_CLASSES);
  const main = document.getElementById('mainColumn');
  main?.classList.add(MAIN_COLUMN_CLASS);
  main?.classList.remove('main-column--board-view');
  page.show(view);
  if (!wasMounted) {
    syncSuperPlanChrome(true);
    notifyAskQuestionDisplayContextChanged();
  }
}

/** Remove the surface and its chrome. The chat underneath is repainted by the caller. */
export function teardownSuperPlanScreen(): void {
  const wasMounted = isSuperPlanPageMounted();
  // Always destroy: someone may have replaced #chatArea under a live page, and
  // its run streams must still close.
  teardownSuperPlanPage();
  if (typeof document === 'undefined') return;
  if (!document.getElementById('orchestratePlanScreen')) {
    document.getElementById('chatArea')?.classList.remove(...CHAT_AREA_CLASSES);
    document.getElementById('mainColumn')?.classList.remove(MAIN_COLUMN_CLASS);
  } else {
    document.getElementById('chatArea')?.classList.remove('chat-area--super-plan');
  }
  if (wasMounted || isSuperPlanChromeActive()) {
    syncSuperPlanChrome(false);
    notifyAskQuestionDisplayContextChanged();
  }
}

/**
 * Paint the surface for a Super Plan chat that came to the foreground in Code
 * (sidebar, notification, reload). Called by `renderChatFromHistory`.
 */
export function reopenSuperPlanScreenForChat(chat: Chat): void {
  if (!SUPER_PLAN_ENABLED) return;
  if (!isSuperPlanChat(chat)) return;
  if (isSuperPlanScreenShowingChat(chat.id)) return;
  showSurface(viewForChat(chat));
}

async function focusChat(chat: Chat): Promise<void> {
  if (sessionState && sessionState.activeId !== chat.id) {
    const { switchChat } = await import('./sidebar');
    await switchChat(chat.id);
  }
}

// ── Choosing a chat ──────────────────────────────────────────────────────────

/** The run most worth showing when the surface opens: one that needs the user, else the newest live one. */
function findLiveSuperPlanChat(): Chat | null {
  const rank = (state: PlanLibraryEntry['state']): number => (state === 'waiting' || state === 'halted' ? 0 : 1);
  const live = collectSuperPlanRuns()
    .filter((run) => run.state === 'waiting' || run.state === 'halted' || run.state === 'running' || run.state === 'paused')
    .sort((a, b) => rank(a.state) - rank(b.state) || (b.atMs ?? 0) - (a.atMs ?? 0));
  for (const run of live) {
    const chat = run.chatId ? findChatById(run.chatId) : null;
    if (chat && isSuperPlanPipelineResumable(chat)) return chat;
  }
  return null;
}

/** A blank Super Plan chat to compose in: an existing spare, else a new chat. */
async function resolveOrCreateComposeChat(excludeChatId?: string): Promise<Chat | null> {
  const spare = sessionState?.chats.find(
    (chat) =>
      chat.id !== excludeChatId &&
      isReusableEmptyPlanChat(chat, 'super-plan') &&
      chatMatchesOpenWorkspace(chat) &&
      !isChatStreaming(chat.id),
  );
  if (spare) return spare;
  const { createChatWithMode } = await import('./sidebar');
  const created = createChatWithMode({ modeId: 'super-plan' });
  if (!created.ok || !created.chatId) return null;
  return findChatById(created.chatId) ?? null;
}

export interface OpenSuperPlanScreenOptions {
  /** Open a blank composer (reusing an empty Super Plan chat) instead of the last or live run. */
  preferNew?: boolean;
  /** The hash is already `#/app/code/super-plan` (router / app-host). */
  skipNavigate?: boolean;
}

async function resolveTarget(options?: OpenSuperPlanScreenOptions): Promise<Chat | null> {
  if (!sessionState) return null;
  if (!options?.preferNew) {
    const active = sessionState.activeId ? findChatById(sessionState.activeId) : undefined;
    if (active && isSuperPlanChat(active) && chatMatchesOpenWorkspace(active)) return active;
    const live = findLiveSuperPlanChat();
    if (live) return live;
  }
  return resolveOrCreateComposeChat();
}

/** Mount the Super Plan surface, remembering which chat to return to. */
export async function openSuperPlanScreen(options?: OpenSuperPlanScreenOptions): Promise<void> {
  // Super Plan is disabled for release — planning happens in Plan mode. The
  // surface keeps its implementation for the `super-plan` branch, but nothing
  // may mount it. See normalizeModeId in src/chat/modes/types.ts.
  if (!SUPER_PLAN_ENABLED) return;
  if (isSuperPlanScreenOpen() && !options?.preferNew) return;
  const { closeOtherCodeStageViews } = await import('./main-column-overlay');
  await closeOtherCodeStageViews('super-plan');

  const active = sessionState?.activeId ? findChatById(sessionState.activeId) : undefined;
  if (!returnChatId && active && !isSuperPlanChat(active)) returnChatId = active.id;

  const target = await resolveTarget(options);
  if (!target) return;
  await focusChat(target);
  showSurface(viewForChat(target));

}

/** Strictly in the open folder: a chat from elsewhere would move the workspace, or be swapped out by Code's own restore. */
function isInOpenWorkspace(chat: Chat): boolean {
  const workspace = getWorkspacePath()?.trim();
  return !workspace || isChatInWorkspace(chat, workspace);
}

/**
 * The chat to show when the surface closes: the one that was foreground when
 * it opened, else any conversation in this folder. Null means every chat here
 * is a plan, and the caller opens a fresh one.
 */
function resolveReturnChat(): Chat | null {
  const remembered = returnChatId ? findChatById(returnChatId) : undefined;
  const active = sessionState?.activeId ? findChatById(sessionState.activeId) : undefined;
  for (const chat of [remembered, active]) {
    if (chat && !isSuperPlanChat(chat) && isInOpenWorkspace(chat)) return chat;
  }
  return (
    sessionState?.chats.find((chat) => !isSuperPlanChat(chat) && isInOpenWorkspace(chat) && chatHasListableContent(chat)) ??
    null
  );
}

/** Close the surface and restore the chat that was foreground when it opened. */
export async function closeSuperPlanScreen(): Promise<void> {
  if (!isSuperPlanScreenOpen()) return;
  const target = resolveReturnChat();
  teardownSuperPlanScreen();
  returnChatId = null;
  const { navigateToCodeChatIfCurrentSection } = await import('../os/router');
  if (!target) {
    // Every chat here is a plan. Land on a fresh chat, or the Code view would
    // paint the active plan chat and bring the surface straight back.
    const { createChatWithMode } = await import('./sidebar');
    createChatWithMode({ modeId: DEFAULT_MODE_ID });
    navigateToCodeChatIfCurrentSection('chat');
    return;
  }
  if (sessionState && sessionState.activeId !== target.id) {
    await focusChat(target);
  } else {
    const { renderChatFromHistory } = await import('./messages');
    renderChatFromHistory(target);
  }
  navigateToCodeChatIfCurrentSection('chat');
}

/** View-bar toggle: press to open, press again to leave. */
export async function toggleSuperPlanScreenFromTopbar(): Promise<void> {
  if (isSuperPlanScreenOpen()) {
    await closeSuperPlanScreen();
    return;
  }
  await openSuperPlanScreen();
}

// ── Starting ─────────────────────────────────────────────────────────────────

/**
 * Start a plan. A chat that already owns a run never gets a second one; the
 * new run takes a fresh chat so both stay reachable from the rail.
 */
async function startPlan(chatId: string, prompt: string): Promise<void> {
  const text = prompt.trim();
  if (!text) throw new Error('Describe what the plan should cover.');
  let chat = findChatById(chatId);
  if (!chat) throw new Error('This chat is gone. Start a new plan.');
  if (chat.superPlanRunId) {
    const fresh = await resolveOrCreateComposeChat(chat.id);
    if (!fresh) throw new Error('Could not open a chat for the new plan.');
    chat = fresh;
    await focusChat(chat);
  }
  const view = await startSuperPlan(chat, text);
  refreshSuperPlanLibrary();
  if (!isChatAppForeground()) showSurface({ mode: 'run', chatId: chat.id, runId: view.runId });
}

/** True when a composer send in this chat should start a Super Plan instead of a chat turn. */
export function shouldRouteComposerSendToSuperPlan(
  chat: Chat,
  opts: { userText: string; skillId: string | null; attachmentCount: number },
): boolean {
  if (!isSuperPlanChat(chat)) return false;
  if (!opts.userText.trim()) return false;
  if (opts.skillId) return false;
  return opts.attachmentCount === 0;
}

/** Start a plan from the chat composer of a Super Plan chat. */
export async function startSuperPlanFromComposer(chat: Chat, promptText: string): Promise<void> {
  try {
    await startPlan(chat.id, promptText);
  } catch (err) {
    setStatus('err', err instanceof Error ? err.message : 'Could not start the plan');
  }
}

// ── Library actions ──────────────────────────────────────────────────────────

async function deletePlanFiles(paths: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const path of paths) {
    try {
      await deleteSuperPlanPlanFile(path);
    } catch {
      failed.push(path);
    }
  }
  return failed;
}

/** Files a run wrote, from its chat summary. */
function runFiles(chat: Chat | undefined): string[] {
  const sp = chat?.superPlanView;
  if (!sp) return [];
  return [sp.specPath, sp.planPath].filter((path): path is string => Boolean(path?.trim()));
}

async function deleteEntry(entry: PlanLibraryEntry): Promise<void> {
  const title = entry.title.trim() || 'this plan';
  const chat = entry.chatId ? findChatById(entry.chatId) : undefined;

  if (!chat) {
    if (!entry.path) return;
    if (!isLocalServerAvailable()) {
      await appAlert('Start the local server to delete plan files.');
      return;
    }
    const ok = await appConfirm(`Delete ${entry.path}? The file is removed from the workspace.`, {
      title: `Delete "${title}"`,
      confirmLabel: 'Delete file',
      danger: true,
    });
    if (!ok) return;
    const failed = await deletePlanFiles([entry.path]);
    if (failed.length) setStatus('err', `Could not delete ${failed.join(', ')}`);
    else setStatus('ok', 'Plan deleted');
    if (getSuperPlanPageView()?.mode === 'doc') await showAfterDelete();
    refreshSuperPlanLibrary();
    return;
  }

  const files = runFiles(chat);
  const live = isSuperPlanPipelineResumable(chat);
  const choice = await appChoice({
    title: `Delete "${title}"`,
    message: live
      ? 'This plan is still in progress. Deleting stops it and removes its run and chat.'
      : 'This removes the plan’s run and chat.',
    buttons: [
      { id: 'cancel', label: 'Keep' },
      { id: 'delete', label: 'Delete', danger: true, primary: true },
    ],
    cancelId: 'cancel',
    ...(files.length && isLocalServerAvailable()
      ? { checkboxLabel: `Also delete its files (${files.map((p) => p.split('/').pop()).join(', ')})`, checkboxChecked: false }
      : {}),
  });
  if (choice.id !== 'delete') return;

  if (live) await cancelSuperPlan(chat).catch(() => undefined);
  await deleteSuperPlanRunForChat(chat).catch((err) => {
    console.warn('[super-plan] could not delete run journal:', err);
  });
  if (choice.checkboxChecked && files.length) {
    const failed = await deletePlanFiles(files);
    if (failed.length) setStatus('err', `Could not delete ${failed.join(', ')}`);
  }

  const wasShowing = isSuperPlanScreenShowingChat(chat.id);
  const { modelId } = readDefaultModelBinding();
  const removed = removeChatById(chat.id, modelId);
  if (removed.ok) {
    scheduleSaveSessions();
    const { renderSidebar } = await import('./sidebar');
    renderSidebar();
  }
  if (wasShowing) await showAfterDelete();
  refreshSuperPlanLibrary();
  setStatus('ok', 'Plan deleted');
}

/** After the shown plan is deleted, land on the next live run or a blank composer. */
async function showAfterDelete(): Promise<void> {
  const next = findLiveSuperPlanChat() ?? (await resolveOrCreateComposeChat());
  if (!next) return;
  await focusChat(next);
  showSurface(viewForChat(next));
}

function leaveSurfaceFor(action: () => void): void {
  teardownSuperPlanScreen();
  returnChatId = null;
  action();
}

function revisePlanFile(path: string): void {
  leaveSurfaceFor(() => {
    void (async () => {
      const [{ createChatWithMode }, { buildRevisePlanComposerDraft }] = await Promise.all([
        import('./sidebar'),
        import('./orchestrate-plan-screen'),
      ]);
      const created = createChatWithMode({ modeId: 'plan', orchestratePlanPath: path });
      const chat = created.ok && created.chatId ? findChatById(created.chatId) : undefined;
      if (!chat) return;
      persistComposerDraftOnChat(chat, buildRevisePlanComposerDraft(path));
      applyComposerDraftForChat(chat);
      scheduleSaveSessions();
      getActiveComposerSurface().inputEl?.focus();
    })();
  });
}

const handlers: SuperPlanPageHandlers = {
  start: (chatId, prompt) => startPlan(chatId, prompt),
  selectRun: (chatId) => {
    const chat = findChatById(chatId);
    if (!chat) return;
    void focusChat(chat).then(() => showSurface(viewForChat(chat)));
  },
  openPlanFile: (path) => {
    const chatId = getSuperPlanPageView()?.chatId ?? sessionState?.activeId;
    if (chatId) showSuperPlanPageView({ mode: 'doc', chatId, path });
  },
  newPlan: () => {
    void openSuperPlanScreen({ preferNew: true, skipNavigate: true });
  },
  deleteEntry: (entry) => {
    void deleteEntry(entry).catch((err) => setStatus('err', err instanceof Error ? err.message : 'Delete failed'));
  },
  openSettings: () => {
    void import('./settings-page').then((m) => m.openSettings('agent-center', { searchKey: 'modes.super-plan' }));
  },
  openFile: (path) => {
    void import('./file-viewer').then((m) => m.openFileInViewer(path));
  },
  orchestrate: (path) => {
    leaveSurfaceFor(() => {
      void import('./orchestrate-launch').then((m) => m.launchBoardFromPlan(path));
    });
  },
  build: (path) => {
    leaveSurfaceFor(() => {
      void import('./sidebar').then((m) =>
        m.createChatWithMode({
          modeId: 'build',
          orchestratePlanPath: path,
          initialUserMessage: `Implement the plan at ${path}.`,
        }),
      );
    });
  },
  revisePlanFile,
};

// ── Wiring ───────────────────────────────────────────────────────────────────

/** Wire the view-bar button and keep run summaries fresh (idempotent). */
export function initSuperPlanEntry(): void {
  if (initialized) return;
  initialized = true;
  document.getElementById('btnSuperPlan')?.addEventListener('click', () => {
    void toggleSuperPlanScreenFromTopbar();
  });
  syncSuperPlanChrome(isSuperPlanScreenOpen());
  startSuperPlanBackgroundSync();
}

/** Clear entry state between tests. */
export function resetSuperPlanEntryForTests(): void {
  teardownSuperPlanScreen();
  returnChatId = null;
  initialized = false;
  syncSuperPlanChrome(false);
}
