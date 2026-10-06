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
import { autoResize } from './composer-auto-resize';

/** Matches `HUB_ROOT_ID` in hub.ts — DOM probe avoids a hub import cycle. */
const HUB_ROOT_ID = 'vibeHub';

function isHubComposerActive(): boolean {
  return Boolean(document.getElementById(HUB_ROOT_ID));
}

let trackedChatId: string | null = null;
let historyIndex = 0;
interface PromptSnapshot {
  text: string;
  start: number;
  end: number;
  direction: HTMLTextAreaElement['selectionDirection'];
  scrollTop: number;
}
let draft: PromptSnapshot | null = null;
let durableDraftText = '';
let displayedRecallText = '';
const recalledEdits = new Map<number, PromptSnapshot>();

function snapshotPrompt(input: HTMLTextAreaElement): PromptSnapshot {
  return {
    text: input.value,
    start: input.selectionStart,
    end: input.selectionEnd,
    direction: input.selectionDirection,
    scrollTop: input.scrollTop,
  };
}

/** Keep the unsent draft durable while history entries temporarily occupy the field. */
export function composerPromptHistoryDraft(input: HTMLTextAreaElement, chatId?: string): string {
  if (!draft) return input.value;
  // Chat switches update activeId before flushing the field belonging to the old chat.
  const scope = chatId && !isHubComposerActive() ? chatId : resolvePromptHistoryScopeKey();
  if (trackedChatId !== scope) return input.value;
  // Explicit typing into a recalled prompt is a new draft, and must be saved too.
  if (input.value !== displayedRecallText) durableDraftText = input.value;
  return durableDraftText;
}

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

function applyRecalledPrompt(input: HTMLTextAreaElement, prompt: PromptSnapshot): void {
  displayedRecallText = prompt.text;
  input.value = prompt.text;
  input.setSelectionRange(prompt.start, prompt.end, prompt.direction);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  autoResize(input);
  input.scrollTop = prompt.scrollTop;
}

function syncChatScope(chatId: string, promptCount: number): void {
  if (trackedChatId !== chatId) {
    trackedChatId = chatId;
    historyIndex = promptCount;
    draft = null;
    recalledEdits.clear();
  } else if (!draft) {
    historyIndex = promptCount;
  }
}

/** Snap recall position to the draft tail after send or composer clear. */
export function resetComposerPromptHistory(scopeKey?: string): void {
  const id = scopeKey ?? resolvePromptHistoryScopeKey();
  const prompts = resolvePromptsForNavigation();
  trackedChatId = id;
  historyIndex = prompts.length;
  draft = null;
  recalledEdits.clear();
}

/** @internal Reset module state between happy-dom test runs. */
export function __resetComposerPromptHistoryForTests(): void {
  trackedChatId = null;
  historyIndex = 0;
  draft = null;
  recalledEdits.clear();
}

/** Plain arrows recall at single-line edges; Alt+arrows explicitly browse any prompt. */
export function handleComposerPromptHistoryKeydown(
  e: KeyboardEvent,
  input: HTMLTextAreaElement,
): boolean {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false;
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing || e.repeat) return false;

  const prompts = resolvePromptsForNavigation();
  if (prompts.length === 0) return false;

  syncChatScope(resolvePromptHistoryScopeKey(), prompts.length);

  if (!e.altKey) {
    // Wrapped lines need the same caret navigation as explicit newlines.
    const style = input.ownerDocument.defaultView?.getComputedStyle(input);
    const lineHeight = parseFloat(style?.lineHeight ?? '') || 22;
    const padding = (parseFloat(style?.paddingTop ?? '') || 0)
      + (parseFloat(style?.paddingBottom ?? '') || 0);
    const singleLineHeight = Math.max(lineHeight + padding, parseFloat(style?.minHeight ?? '') || 0);
    if (input.value.includes('\n') || (input.value && input.scrollHeight > singleLineHeight + 1)) return false;
    if (e.key === 'ArrowUp' && !isComposerCaretAtStart(input)) return false;
    if (e.key === 'ArrowDown' && !isComposerCaretAtEnd(input)) return false;
  }

  const nextIndex = e.key === 'ArrowUp' ? historyIndex - 1 : historyIndex + 1;
  if (nextIndex < 0 || nextIndex > prompts.length) return false;

  if (!draft) {
    draft = snapshotPrompt(input);
    durableDraftText = input.value;
  } else {
    if (input.value !== displayedRecallText) durableDraftText = input.value;
    recalledEdits.set(historyIndex, snapshotPrompt(input));
  }
  historyIndex = nextIndex;

  const text = prompts[historyIndex] ?? '';
  const next = historyIndex === prompts.length ? draft : recalledEdits.get(historyIndex) ?? {
    text, start: text.length, end: text.length, direction: 'none' as const, scrollTop: 0,
  };
  if (historyIndex === prompts.length) {
    draft = null;
  }

  e.preventDefault();
  applyRecalledPrompt(input, next);
  return true;
}
