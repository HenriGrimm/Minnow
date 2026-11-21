/**
 * `chat_create` for automations that opted in (`allowChatCreation` on the job,
 * `--allow-chat-create` on the run). A scheduled run has no person to confirm,
 * so the job's setting is the approval: the tool saves a new top-level chat and,
 * with a first message, starts it through the same scheduler command route
 * a job targeting an existing chat uses. That new chat's turns carry scheduler
 * provenance, so they cannot open further chats themselves.
 */

import { randomUUID } from 'node:crypto';
import type { OpenAIFunctionDefinition } from '../tools/definitions';
import type { ToolExecutionResult } from '../types';
import { persistHeadlessChat } from './persist-chat';
import { headlessApiUrl } from './server-context';

export const AUTOMATION_CHAT_CREATE_LIMIT = 10;

export const AUTOMATION_CHAT_CREATE_TOOL: OpenAIFunctionDefinition = {
  type: 'function',
  function: {
    name: 'chat_create',
    description: 'Open a new top-level chat in this automation\'s workspace. This automation is allowed to do so without asking. '
      + 'Give a short title; an optional message starts work there right away. The new chat runs on its own: '
      + `you get its id, not its reply. At most ${AUTOMATION_CHAT_CREATE_LIMIT} per run.`,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Sidebar title for the new chat (up to 240 characters).' },
        message: { type: 'string', description: 'Optional first message to start work in the new chat (up to 24 KB).' },
      },
      required: ['title'],
    },
  },
};

export interface AutomationChatContext {
  workspacePath: string;
  modeId: string;
  providerId: string;
  modelId: string;
}

export interface AutomationChatAdapters {
  fetch?: typeof fetch;
  id?: () => string;
  persist?: typeof persistHeadlessChat;
}

/** One creator per run: counts creations against the per-run limit. */
export function createAutomationChatCreator(context: () => AutomationChatContext, adapters: AutomationChatAdapters = {}) {
  const fetchApi = adapters.fetch ?? globalThis.fetch;
  const newId = adapters.id ?? randomUUID;
  const persist = adapters.persist ?? persistHeadlessChat;
  let created = 0;
  return async function createChat(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    if (!title || title.length > 240) return { content: 'Error: chat_create needs a title of 1–240 characters.' };
    const message = args.message === undefined ? undefined : typeof args.message === 'string' ? args.message : null;
    if (message === null || (message !== undefined && (!message.trim() || Buffer.byteLength(message) > 24_000))) {
      return { content: 'Error: message must be non-empty text up to 24 KB, or omitted.' };
    }
    if (created >= AUTOMATION_CHAT_CREATE_LIMIT) {
      return { content: `Error: this run already opened ${AUTOMATION_CHAT_CREATE_LIMIT} chats, the per-run limit. Do not retry.` };
    }
    signal?.throwIfAborted();
    const current = context();
    const chatId = `auto-${newId()}`;
    created++;
    await persist({ chatId, chatName: title, workspacePath: current.workspacePath, modeId: current.modeId,
      providerId: current.providerId, modelId: current.modelId, workAgentId: null, history: [] });
    const link = '#/app/code/chat?chatId=' + encodeURIComponent(chatId);
    if (message === undefined) return { content: JSON.stringify({ chatId, link, disposition: 'created' }) };
    const response = await fetchApi(headlessApiUrl(`/api/chats/${encodeURIComponent(chatId)}/commands`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Minnow-Chat-Protocol': '1', 'X-Minnow-Chat-Client': 'scheduler' },
      body: JSON.stringify({ action: 'send', text: message, mode: 'auto', clientRequestId: `${chatId}-first` }),
      signal,
    });
    const body = await response.json().catch(() => ({})) as { receipt?: { commandId?: string; state?: string }; error?: { message?: string } | string };
    if (!response.ok) {
      const reason = typeof body.error === 'string' ? body.error : body.error?.message ?? `HTTP ${response.status}`;
      return { content: `Error: opened chat ${chatId} but could not start its first message (${reason}). Do not retry the creation.` };
    }
    return { content: JSON.stringify({ chatId, link, commandId: body.receipt?.commandId, disposition: body.receipt?.state ?? 'queued' }) };
  };
}
