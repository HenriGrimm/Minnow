/**
 * Client for manual Brain capture (chat + research summary pages).
 */

import { getWorkspacePath } from '../state/workspace';
import { stripThinkingForExcerpt } from '../synthesis/post-turn';
import { isLocalServerAvailable } from '../tools/config';
import type { Chat, Message } from '../types';

const API_BASE = '';

export interface BrainCaptureResult {
  relPath: string;
  title: string;
  pageId?: string;
  created?: boolean;
}

type CapturePostResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function messageText(content: string | undefined | null): string {
  if (typeof content === 'string') return content.trim();
  return '';
}

/** Walk chat history into plain user/assistant rows for capture API. */
export function serializeChatForCapture(
  chat: Chat,
): Array<{ role: string; content: string }> {
  const rows: Array<{ role: string; content: string }> = [];
  for (const msg of chat.history) {
    if (msg.role === 'user') {
      const text = messageText(msg.content);
      if (text) rows.push({ role: 'user', content: text });
      continue;
    }
    if (msg.role === 'assistant') {
      const text = stripThinkingForExcerpt(messageText(msg.content));
      if (text) rows.push({ role: 'assistant', content: text });
      continue;
    }
    if (msg.role === 'tool') {
      const text = messageText(msg.content);
      if (text) {
        const short = text.length > 120 ? `${text.slice(0, 120)}…` : text;
        rows.push({ role: 'tool', content: `[tool result] ${short}` });
      }
    }
  }
  return rows;
}

async function capturePost<T>(path: string, body: unknown): Promise<CapturePostResult<T>> {
  if (!isLocalServerAvailable()) {
    return { ok: false, error: 'Minnow is not running locally — open or restart the app' };
  }
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {
      return { ok: false, error: String(data?.error ?? res.statusText) };
    }
    return { ok: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Capture request failed';
    return { ok: false, error: msg };
  }
}

/** POST chat transcript to Brain capture API. */
export async function captureChatToBrain(
  chat: Chat,
): Promise<BrainCaptureResult | null> {
  const messages = serializeChatForCapture(chat);
  const workspaceRoot = chat.workspacePath || getWorkspacePath();

  const result = await capturePost<{
    relPath: string;
    title: string;
    pageId?: string;
    created?: boolean;
  }>('/api/brain/capture/chat', {
    chatId: chat.id,
    title: chat.name,
    workspaceRoot,
    messages,
  });

  if (result.ok === false) {
    throw new Error(result.error);
  }
  return {
    relPath: result.data.relPath,
    title: result.data.title,
    pageId: result.data.pageId,
    created: result.data.created,
  };
}

/** POST research id to Brain capture API. */
export async function captureResearchToBrain(
  researchId: string,
): Promise<BrainCaptureResult | null> {
  const result = await capturePost<{
    relPath: string;
    title: string;
    pageId?: string;
    created?: boolean;
  }>('/api/brain/capture/research', { researchId });

  if (result.ok === false) {
    throw new Error(result.error);
  }
  return {
    relPath: result.data.relPath,
    title: result.data.title,
    pageId: result.data.pageId,
    created: result.data.created,
  };
}
