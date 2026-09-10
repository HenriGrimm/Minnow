/**
 * Cold-boot foreground: Super Plan is a screen, not the default Code landing.
 *
 * If the last session ended with a spare super-plan composer or a finished run
 * still marked active, reopening would mount the plan surface on every launch.
 * In-flight pipelines stay foreground so work can resume.
 */

import { isSuperPlanPipelineResumable, isSuperPlanTransportChat } from '../chat/super-plan/client';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import {
  CODE_APP_ID,
  getChatLastMessageAt,
  getLastActiveChatIdForApp,
} from '../state/session-workspace-scope';
import {
  findChatById,
  markSessionScalarsDirty,
  scheduleSaveSessions,
  sessionState,
} from '../state/sessions';
import type { Chat, SessionState } from '../types';

function pickFallbackForegroundChat(state: SessionState, avoidId: string): Chat | null {
  const avoided = state.chats.find((c) => c.id === avoidId);
  const workspaceKey = normalizeWorkspacePath(avoided?.workspacePath ?? '');

  const rememberedWorkspace = state.lastActiveChatIdByWorkspace?.[workspaceKey];
  if (rememberedWorkspace && rememberedWorkspace !== avoidId) {
    const chat = state.chats.find((c) => c.id === rememberedWorkspace);
    if (chat && !isSuperPlanTransportChat(chat)) return chat;
  }

  const rememberedApp = getLastActiveChatIdForApp(state, CODE_APP_ID);
  if (rememberedApp && rememberedApp !== avoidId) {
    const chat = state.chats.find((c) => c.id === rememberedApp);
    if (chat && !isSuperPlanTransportChat(chat)) return chat;
  }

  const scoped = state.chats
    .filter(
      (c) =>
        c.id !== avoidId &&
        !isSuperPlanTransportChat(c) &&
        normalizeWorkspacePath(c.workspacePath ?? '') === workspaceKey,
    )
    .sort((a, b) => getChatLastMessageAt(b) - getChatLastMessageAt(a));
  if (scoped.length) return scoped[0]!;

  const any = state.chats
    .filter((c) => c.id !== avoidId && !isSuperPlanTransportChat(c))
    .sort((a, b) => getChatLastMessageAt(b) - getChatLastMessageAt(a));
  return any[0] ?? null;
}

/** Point `activeId` at a normal chat when the saved foreground was Super Plan transport only. */
export function reconcileBootForegroundAwayFromSuperPlan(): void {
  if (!sessionState?.activeId) return;
  const active = findChatById(sessionState.activeId);
  if (!active || !isSuperPlanTransportChat(active)) return;
  if (isSuperPlanPipelineResumable(active)) return;

  const fallback = pickFallbackForegroundChat(sessionState, active.id);
  if (!fallback) return;

  sessionState.activeId = fallback.id;
  markSessionScalarsDirty();
  scheduleSaveSessions();
}
