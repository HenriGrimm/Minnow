import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import { isPlaceholderChatName } from './titles/placeholder';
import type { Chat } from '../types';

export interface ChatSearchResult {
  chat: Chat;
  score: number;
  /** Where the best match came from. */
  matchedIn: 'title' | 'message';
  messageIndex?: number;
  /** Matched message role when matchedIn === 'message'. */
  role?: 'user' | 'assistant';
  /** Short excerpt around the first matched keyword. */
  snippet: string;
}

interface TextMatch {
  score: number;
  /** Offset of the earliest matched token (snippet anchor). */
  firstIndex: number;
}

const DEFAULT_RESULT_LIMIT = 30;
const SNIPPET_BEFORE_CHARS = 32;
const SNIPPET_TOTAL_CHARS = 110;
/** Title hits outrank message hits of the same raw token score. */
const TITLE_WEIGHT = 2;

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}_]/u.test(ch);
}

function scoreToken(token: string, text: string): TextMatch | null {
  const idx = text.indexOf(token);
  if (idx >= 0) {
    const atWordStart = idx === 0 || !isWordChar(text[idx - 1]);
    return { score: 100 + (atWordStart ? 40 : 0), firstIndex: idx };
  }
  if (token.length < 2) return null;

  const maxSpan = token.length * 4;
  let start = text.indexOf(token[0]);
  let best: TextMatch | null = null;
  while (start >= 0) {
    let ti = 1;
    let last = start;
    for (let i = start + 1; i < text.length && ti < token.length; i++) {
      if (text[i] === token[ti]) {
        last = i;
        ti++;
      }
      if (i - start > maxSpan) break;
    }
    if (ti === token.length) {
      const gap = last - start + 1 - token.length;
      const score = Math.max(1, 60 - gap * 4);
      if (!best || score > best.score) best = { score, firstIndex: start };
      if (gap === 0) break;
    }
    start = text.indexOf(token[0], start + 1);
  }
  return best;
}

/** Split a query into lowercased keyword tokens. */
export function tokenizeQuery(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchText(tokens: string[], text: string): TextMatch | null {
  if (!tokens.length) return null;
  const lower = text.toLowerCase();
  let score = 0;
  let firstIndex = lower.length;
  for (const token of tokens) {
    const hit = scoreToken(token, lower);
    if (!hit) return null;
    score += hit.score;
    if (hit.firstIndex < firstIndex) firstIndex = hit.firstIndex;
  }
  return { score, firstIndex };
}

/** Collapse whitespace and clip a window around the match for display. */
function buildSnippet(text: string, firstIndex: number): string {
  let start = Math.max(0, firstIndex - SNIPPET_BEFORE_CHARS);
  while (start > 0 && start < text.length && isWordChar(text[start - 1])) start--;
  const raw = text.slice(start, start + SNIPPET_TOTAL_CHARS);
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const prefix = start > 0 ? '…' : '';
  const suffix = start + SNIPPET_TOTAL_CHARS < text.length ? '…' : '';
  return `${prefix}${collapsed}${suffix}`;
}

/** Message text eligible for search (user/assistant with non-empty string content). */
function searchableMessageText(message: Chat['history'][number]): string | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  const content = typeof message.content === 'string' ? message.content : '';
  return content.trim() ? content : null;
}

/** True for unsent draft rows that should never appear in results. */
function isSearchableChat(chat: Chat): boolean {
  return chat.history.length > 0 || !isPlaceholderChatName(chat.name);
}

function firstMessagePreview(chat: Chat): string {
  for (const message of chat.history) {
    const text = searchableMessageText(message);
    if (text) return buildSnippet(text, 0);
  }
  return '';
}

/** Best match for one chat across its title and message history, or null. */
export function scoreChat(chat: Chat, tokens: string[], match?: 'title' | 'message'): ChatSearchResult | null {
  if (!isSearchableChat(chat)) return null;

  let best: ChatSearchResult | null = null;
  const titleHit = match === 'message' ? null : matchText(tokens, chat.name);
  if (titleHit) {
    best = {
      chat,
      score: titleHit.score * TITLE_WEIGHT,
      matchedIn: 'title',
      snippet: firstMessagePreview(chat),
    };
  }

  for (const [messageIndex, message] of (match === 'title' ? [] : chat.history).entries()) {
    const text = searchableMessageText(message);
    if (!text) continue;
    const hit = matchText(tokens, text);
    if (!hit || (best && hit.score <= best.score)) continue;
    best = {
      chat,
      score: hit.score,
      matchedIn: 'message',
      messageIndex,
      role: message.role as 'user' | 'assistant',
      snippet: buildSnippet(text, hit.firstIndex),
    };
  }
  return best;
}

/** Keep only chats bound to the given workspace root (normalized path equality). */
export function filterChatsByWorkspacePath(chats: Chat[], workspacePath: string): Chat[] {
  const key = normalizeWorkspacePath(workspacePath);
  if (!key) return chats;
  return chats.filter((chat) => normalizeWorkspacePath(chat.workspacePath ?? '') === key);
}

export function searchChats(
  chats: Chat[],
  query: string,
  options?: { limit?: number; match?: 'title' | 'message' },
): ChatSearchResult[] {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) return [];
  const limit = options?.limit ?? DEFAULT_RESULT_LIMIT;

  const results: ChatSearchResult[] = [];
  for (const chat of chats) {
    const result = scoreChat(chat, tokens, options?.match);
    if (result) results.push(result);
  }
  results.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return (b.chat.lastMessageAt ?? 0) - (a.chat.lastMessageAt ?? 0);
  });
  return results.slice(0, limit);
}
