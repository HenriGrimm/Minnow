import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import type { Message, SessionState } from '../types';
import { isHiddenTranscriptUserMessage } from '../chat/hidden-transcript-user-messages';
import { formatComposerTextFromHistory } from '../skills/history-content';
import { getWorkspacePath } from '../state/workspace';
import {
  getChatLastMessageAt,
  getChatsForWorkspace,
} from '../state/session-workspace-scope';
import { getActiveChat, sessionState } from '../state/sessions';
import { resolveHistoryNavigation } from './terminal-history-nav';

/** Matches `HUB_ROOT_ID` in hub.ts — DOM probe avoids a hub import cycle. */
const HUB_ROOT_ID = 'vibeHub';

function isHubComposerActive(): boolean {
  return Boolean(document.getElementById(HUB_ROOT_ID));
}

let trackedChatId: string | null = null;
let historyIndex = 0;

/** Collect editable user prompts from chat history (newest last). */
export function collectChatUserPrompts(history: Message[]): string[] {
  const prompts: string[] = [];
  for (const row of history) {
    if (row.role !== 'user') continue;
    if ('goalAchieved' in row && row.goalAchieved) continue;
    // Hidden / leaked VLM follow-ups are not composer recall; skip before text work.
    if (isHiddenTranscriptUserMessage(row)) continue;
    const text = formatComposerTextFromHistory(row.content);
    if (!text.trim()) continue;
    prompts.push(text);
  }
  return prompts;
}

/** Collect user prompts across workspace chats, oldest chat activity first. */
export function collectWorkspaceUserPrompts(
  state: SessionState,
  workspacePath: string,
): string[] {
  const chats = getChatsForWorkspace(workspacePath, state)
    .filter((chat) => chat.history.length > 0)
    .sort((a, b) => getChatLastMessageAt(a) - getChatLastMessageAt(b));
  const prompts: string[] = [];
  for (const chat of chats) {
    prompts.push(...collectChatUserPrompts(chat.history));
  }
  return prompts;
}

function hubPromptScopeKey(workspacePath: string): string {
  return `hub:${normalizeWorkspacePath(workspacePath)}`;
}

function resolvePromptHistoryScopeKey(): string {
  if (isHubComposerActive()) {
    return hubPromptScopeKey(getWorkspacePath());
  }
  return getActiveChat().id;
}

function resolvePromptsForNavigation(): string[] {
  if (isHubComposerActive() && sessionState) {
    return collectWorkspaceUserPrompts(sessionState, getWorkspacePath());
  }
  return collectChatUserPrompts(getActiveChat().history);
}

/** True when a collapsed caret sits at the start of the composer (Up may recall). */
export function isComposerCaretAtStart(input: HTMLTextAreaElement): boolean {
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? 0;
  return start === end && start === 0;
}

/** True when a collapsed caret sits at the end of the composer (Down may advance). */
export function isComposerCaretAtEnd(input: HTMLTextAreaElement): boolean {
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? 0;
  const len = input.value.length;
  return start === end && start === len;
}

function resizeComposerInput(input: HTMLTextAreaElement): void {
  void import('./input').then((m) => m.autoResize(input));
}

function applyRecalledPrompt(input: HTMLTextAreaElement, text: string): void {
  input.value = text;
  const caret = text.length;
  input.selectionStart = caret;
  input.selectionEnd = caret;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  resizeComposerInput(input);
}

function syncChatScope(chatId: string, promptCount: number): void {
  if (trackedChatId !== chatId) {
    trackedChatId = chatId;
    historyIndex = promptCount;
  }
}

/** Snap recall position to the draft tail after send or composer clear. */
export function resetComposerPromptHistory(scopeKey?: string): void {
  const id = scopeKey ?? resolvePromptHistoryScopeKey();
  const prompts = resolvePromptsForNavigation();
  trackedChatId = id;
  historyIndex = prompts.length;
}

/** @internal Reset module state between happy-dom test runs. */
export function __resetComposerPromptHistoryForTests(): void {
  trackedChatId = null;
  historyIndex = 0;
}

/** Navigate prior user prompts when ArrowUp/Down are pressed at the composer edges. */
export function handleComposerPromptHistoryKeydown(
  e: KeyboardEvent,
  input: HTMLTextAreaElement,
): boolean {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false;
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  if (e.shiftKey) return false;

  const prompts = resolvePromptsForNavigation();
  if (prompts.length === 0) return false;

  syncChatScope(resolvePromptHistoryScopeKey(), prompts.length);

  if (e.key === 'ArrowUp' && !isComposerCaretAtStart(input)) return false;
  if (e.key === 'ArrowDown' && !isComposerCaretAtEnd(input)) return false;

  const arrow = e.key === 'ArrowUp' ? 'up' : 'down';
  const nav = resolveHistoryNavigation({ historyIndex, tabHistory: prompts }, arrow);
  historyIndex = nav.historyIndex;

  e.preventDefault();
  applyRecalledPrompt(input, nav.nextLine);
  return true;
}
