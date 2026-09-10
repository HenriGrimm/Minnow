import '../styles/super-plan-page.css';

import { collectSuperPlanRuns, isChatInCurrentWorkspace } from '../chat/super-plan/plan-library';
import { isReusableEmptyPlanChat } from '../chat/super-plan/spare-chat';
import { normalizeModeId } from '../chat/modes/types';
import { isChatStreaming } from '../chat/streaming-state';
import { findChatById, sessionState } from '../state/sessions';
import { getWorkspacePath } from '../state/workspace';
import type { Chat } from '../types';
import {
  derivePlanScreenPhaseFromSuperPlan,
  getOrchestratePlanScreenSession,
  isSuperPlanPipelineResumable,
  renderOrchestratePlanScreen,
  teardownOrchestratePlanScreen,
  type OrchestratePlanScreenPhase,
} from './orchestrate-plan-screen';
import { isSuperPlanPageMounted } from './super-plan-page';
import { syncSuperPlanChrome } from './super-plan-chrome';
import { createChatWithMode, switchChat } from './sidebar';

let returnChatId: string | null = null;
let initialized = false;

/** True when the Super Plan surface owns the stage. */
export function isSuperPlanScreenOpen(): boolean {
  return isSuperPlanPageMounted();
}

function isSuperPlanChat(chat: Chat | null | undefined): boolean {
  return Boolean(chat && normalizeModeId(chat.modeId) === 'super-plan');
}

/** Every other full-column Code view stands down before the surface mounts. */
async function closeCompetingMainColumnViews(): Promise<void> {
  const { closeOtherCodeStageViews } = await import('./main-column-overlay');
  await closeOtherCodeStageViews('super-plan');
}

/** Newest super-plan chat whose pipeline has not finished. */
function findLiveSuperPlanChat(): Chat | null {
  const live = collectSuperPlanRuns()
    .filter((run) => run.state !== 'done' && run.state !== 'saved')
    .sort((a, b) => (b.atMs ?? 0) - (a.atMs ?? 0));
  for (const run of live) {
    const chat = run.chatId ? findChatById(run.chatId) : null;
    if (chat && isSuperPlanPipelineResumable(chat)) return chat;
  }
  return null;
}

function chatMatchesOpenWorkspace(chat: Chat): boolean {
  const ws = getWorkspacePath();
  if (!ws?.trim()) return true;
  return isChatInCurrentWorkspace(chat);
}

/** An empty super-plan chat is a spare composer; reuse it before making another. */
function resolveOrCreateComposeChat(): Chat | null {
  const spare = sessionState?.chats.find(
    (c) =>
      isReusableEmptyPlanChat(c, 'super-plan') &&
      chatMatchesOpenWorkspace(c) &&
      !isChatStreaming(c.id),
  );
  if (spare) return spare;

  const created = createChatWithMode({ modeId: 'super-plan' });
  if (!created.ok || !created.chatId) return null;
  return findChatById(created.chatId) ?? null;
}

interface SuperPlanTarget {
  chat: Chat;
  phase: OrchestratePlanScreenPhase;
}

/** Options for {@link openSuperPlanScreen}. */
export interface OpenSuperPlanScreenOptions {
  /** Skip resuming the last planning session or an in-flight run and open a blank Super Plan composer (reuse an empty spare chat when one exists). */
  preferNew?: boolean;
  /** Hash is already `#/app/code/super-plan` (router / app-host). */
  skipNavigate?: boolean;
}

function resolveSuperPlanTarget(options?: OpenSuperPlanScreenOptions): SuperPlanTarget | null {
  if (!sessionState) return null;

  if (!options?.preferNew) {
    const session = getOrchestratePlanScreenSession();
    const sessionChat = session ? findChatById(session.chatId) : null;
    if (isSuperPlanChat(sessionChat) && isChatInCurrentWorkspace(sessionChat!)) {
      return {
        chat: sessionChat!,
        phase: sessionChat!.superPlanView
          ? derivePlanScreenPhaseFromSuperPlan(sessionChat!)
          : 'prompt',
      };
    }

    const live = findLiveSuperPlanChat();
    if (live) return { chat: live, phase: derivePlanScreenPhaseFromSuperPlan(live) };
  }

  const compose = resolveOrCreateComposeChat();
  return compose ? { chat: compose, phase: 'prompt' } : null;
}

/** Mount the Super Plan surface, remembering where to come back to. */
export async function openSuperPlanScreen(options?: OpenSuperPlanScreenOptions): Promise<void> {
  if (isSuperPlanScreenOpen() && !options?.preferNew) return;

  await closeCompetingMainColumnViews();

  const activeChat = sessionState?.activeId ? findChatById(sessionState.activeId) : null;
  if (!returnChatId && activeChat && !isSuperPlanChat(activeChat)) {
    returnChatId = activeChat.id;
  }

  const target = resolveSuperPlanTarget(options);
  if (!target) return;

  if (options?.preferNew) {
    teardownOrchestratePlanScreen();
  }

  if (sessionState && sessionState.activeId !== target.chat.id) {
    await switchChat(target.chat.id);
  }

  renderOrchestratePlanScreen({
    phase: target.phase,
    chatId: target.chat.id,
    savedPrompt: target.chat.superPlanView?.prompt,
  });

  if (!options?.skipNavigate) {
    const { isOsRouterInitialized, syncCodeSectionHash } = await import('../os/router');
    if (isOsRouterInitialized()) syncCodeSectionHash('super-plan');
  }
}

/** Leave Super Plan for a real conversation. */
function resolveReturnChat(): Chat | null {
  const remembered = returnChatId ? findChatById(returnChatId) : null;
  if (remembered && !isSuperPlanChat(remembered)) return remembered;

  const active = sessionState?.activeId ? findChatById(sessionState.activeId) : null;
  if (active && !isSuperPlanChat(active)) return active;

  return sessionState?.chats.find((c) => !isSuperPlanChat(c)) ?? null;
}

/** Close the surface and restore the chat that was foreground when it opened. */
export async function closeSuperPlanScreen(): Promise<void> {
  if (!isSuperPlanScreenOpen()) return;

  const target = resolveReturnChat();
  teardownOrchestratePlanScreen();
  returnChatId = null;

  if (!target) {
    document.getElementById('chatArea')?.replaceChildren();
    syncSuperPlanChrome(false);
    const { navigateToCodeChatIfCurrentSection } = await import('../os/router');
    navigateToCodeChatIfCurrentSection('super-plan');
    return;
  }

  if (sessionState && sessionState.activeId !== target.id) {
    await switchChat(target.id);
    const { navigateToCodeChatIfCurrentSection } = await import('../os/router');
    navigateToCodeChatIfCurrentSection('super-plan');
    return;
  }
  const { renderChatFromHistory } = await import('./messages');
  renderChatFromHistory(target);
  const { navigateToCodeChatIfCurrentSection } = await import('../os/router');
  navigateToCodeChatIfCurrentSection('super-plan');
}

/** View-bar toggle: press to open, press again to leave. */
export async function toggleSuperPlanScreenFromTopbar(): Promise<void> {
  if (isSuperPlanScreenOpen()) {
    await closeSuperPlanScreen();
    return;
  }
  await openSuperPlanScreen();
}

/** Wire the view-bar button (idempotent). */
export function initSuperPlanEntry(): void {
  if (initialized) return;
  initialized = true;

  document.getElementById('btnSuperPlan')?.addEventListener('click', () => {
    void toggleSuperPlanScreenFromTopbar();
  });
  syncSuperPlanChrome(isSuperPlanScreenOpen());
}

/** Clear entry state between tests. */
export function resetSuperPlanEntryForTests(): void {
  returnChatId = null;
  initialized = false;
  syncSuperPlanChrome(false);
}
