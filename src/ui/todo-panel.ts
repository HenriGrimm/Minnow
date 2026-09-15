import { apiMessageContentToText } from '../api/message-content';
import { getChatTodos } from '../state/sessions';
import type { Chat, ChatTodo } from '../types';

export type TodoPanelItemView = {
  text: string;
  status: ChatTodo['status'];
  marker: 'completed' | 'in_progress' | 'pending';
};

export type TodoPanelView = {
  hidden: boolean;
  progressLabel: string;
  progressRatio: number;
  items: TodoPanelItemView[];
  defaultCollapsed: boolean;
};

function markerForStatus(status: ChatTodo['status']): TodoPanelItemView['marker'] {
  if (status === 'completed') return 'completed';
  if (status === 'in_progress') return 'in_progress';
  return 'pending';
}

/** Pure display helper for the checklist panel (unit-tested without DOM). */
export function deriveTodoPanelView(chat: Chat | null | undefined): TodoPanelView {
  const todos = chat ? (getChatTodos(chat) ?? []) : [];
  if (!todos.length) {
    return {
      hidden: true,
      progressLabel: '',
      progressRatio: 0,
      items: [],
      defaultCollapsed: true,
    };
  }

  const completed = todos.filter((t) => t.status === 'completed').length;
  const hasOpen = todos.some((t) => t.status === 'pending' || t.status === 'in_progress');
  const allComplete = completed === todos.length && todos.length > 0;
  const progressLabel = allComplete ? `${completed}/${todos.length} ✓` : `${completed}/${todos.length}`;
  const progressRatio = todos.length ? completed / todos.length : 0;

  return {
    hidden: false,
    progressLabel,
    progressRatio,
    items: todos.map((item) => ({
      text: item.text,
      status: item.status,
      marker: markerForStatus(item.status),
    })),
    defaultCollapsed: allComplete,
  };
}

export function getTurnTodos(chat: Chat, fork: number, end: number): ChatTodo[] {
  const calls = new Set<string>();
  let todos: ChatTodo[] = [];
  for (const message of chat.history.slice(fork + 1, end + 1)) {
    if (message.role === 'assistant' && 'tool_calls' in message) {
      for (const call of message.tool_calls ?? []) {
        if (call.function.name === 'todo_write') calls.add(call.id);
      }
    }
    if (message.role !== 'tool' || !calls.has(message.tool_call_id)) continue;
    try {
      const result = JSON.parse(apiMessageContentToText(message.content));
      if (Array.isArray(result.todos)) todos = result.todos.filter((item: ChatTodo) =>
        item && typeof item.text === 'string' && ['pending', 'in_progress', 'completed'].includes(item.status));
    } catch { /* Failed calls preserve the last successful checklist. */ }
  }
  return todos;
}

export function syncTodoPanel(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('minnow:todos-changed'));
}

export function createTurnTodoPanel(todos: ChatTodo[]): HTMLDetailsElement | null {
  if (!todos.length) return null;
  const el = document.createElement('details');
  el.className = 'chat-turn-todos';
  const completed = todos.filter((item) => item.status === 'completed').length;
  el.open = completed !== todos.length;
  const header = document.createElement('summary');
  header.className = 'chat-turn-todos__header';
  const title = document.createElement('span');
  title.textContent = 'Todo list';
  const count = document.createElement('span');
  count.className = 'chat-turn-todos__count';
  count.textContent = `${completed} of ${todos.length} complete`;
  header.append(title, count);
  const list = document.createElement('ul');
  list.className = 'chat-turn-todos__list';
  for (const item of todos) {
    const row = document.createElement('li');
    row.className = `chat-turn-todos__item chat-turn-todos__item--${item.status}`;
    const glyph = document.createElement('span');
    glyph.className = 'chat-turn-todos__glyph';
    glyph.setAttribute('aria-label', item.status.replace('_', ' '));
    glyph.textContent = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '●' : '○';
    const text = document.createElement('span');
    text.textContent = item.text;
    row.append(glyph, text);
    list.append(row);
  }
  el.append(header, list);
  return el;
}
