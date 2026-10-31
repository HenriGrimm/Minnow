import {
  clearChatTodos,
  findChatById,
  getChatTodos,
  setChatTodos,
} from '../state/sessions';
import type { Chat } from '../types';
import { syncTodoPanel } from '../ui/todo-panel';

import { validateTodoWriteArgs, formatTodoProgress } from '../../server/runner/todo-write.js';
export { normalizeTodoStatus, normalizeTodoWriteArgs, validateTodoWriteArgs } from '../../server/runner/todo-write.js';
export type { TodoWriteArgs, ValidateTodoWriteResult } from '../../server/runner/todo-write.js';

export type TodoWriteExecutorContext = {
  chatId?: string;
};

/** Execute todo_write — writes to the active chat and refreshes the checklist UI. */
export function executeTodoWrite(
  args: Record<string, unknown>,
  context: TodoWriteExecutorContext = {},
): string {
  const validated = validateTodoWriteArgs(args);
  if (validated.ok === false) return validated.error;

  const chatId = context.chatId?.trim();
  if (!chatId) {
    return 'Error: todo_write requires an active chat context';
  }

  const chat = findChatById(chatId);
  if (!chat) {
    return 'Error: active chat not found';
  }

  const { todos } = validated.args;
  if (todos.length === 0) {
    clearChatTodos(chat);
  } else {
    setChatTodos(chat, todos);
  }

  syncTodoPanel();

  return JSON.stringify({
    progress: formatTodoProgress(getChatTodos(chat) ?? []),
    todos: getChatTodos(chat) ?? [],
  });
}

/** Defense helper for tests — whether todo_write may run on this chat. */
export function isTodoWriteAllowedForChat(chat: Chat | null | undefined): boolean {
  return Boolean(chat);
}
