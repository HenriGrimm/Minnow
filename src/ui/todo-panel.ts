import { apiMessageContentToText } from '../api/message-content';
import { getChatTodos } from '../state/sessions';
import type { Chat, ChatTodo } from '../types';
import { createIcon } from './icon';

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

export function getTurnTodos(chat: Chat, fork: number, end: number): ChatTodo[] | undefined {
  const calls = new Set<string>();
  let todos: ChatTodo[] | undefined;
  for (let i = fork + 1; i <= end; i++) {
    const message = chat.history[i];
    if (message.role === 'assistant' && 'tool_calls' in message) {
      for (const call of message.tool_calls ?? []) {
        if (call.function.name === 'todo_write') calls.add(call.id);
      }
    }
    if (message.role !== 'tool' || !calls.has(message.tool_call_id)) continue;
    try {
      const result = JSON.parse(apiMessageContentToText(message.content));
      if (Array.isArray(result?.todos)) todos = result.todos.filter((item: ChatTodo) =>
        item && typeof item.text === 'string' && ['pending', 'in_progress', 'completed'].includes(item.status));
    } catch { /* Failed calls preserve the last successful checklist. */ }
  }
  return todos;
}

export function syncTodoPanel(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new window.Event('minnow:todos-changed'));
}

export function createTurnTodoPanel(todos: ChatTodo[], floating = false): HTMLDetailsElement | null {
  if (!todos.length) return null;
  const el = document.createElement('details');
  el.className = 'chat-turn-todos';
  el.classList.toggle('chat-todo-panel', floating);
  el.open = todos.some(item => item.status !== 'completed');
  const header = document.createElement('summary');
  header.className = 'chat-turn-todos__header';
  const title = document.createElement('span');
  title.textContent = 'Todo list';
  const count = document.createElement('span');
  count.className = 'chat-turn-todos__count';
  if (floating) header.append(createIcon('clipboardChecklist', { className: 'chat-todo-panel__icon', size: 16 }));
  header.append(title, count);
  if (floating) header.append(createIcon('chevronRight', { className: 'chat-todo-panel__chevron', size: 14 }));
  const list = document.createElement('ul');
  list.className = 'chat-turn-todos__list';
  el.append(header, list);
  updateTodoPanel(el, todos);
  return el;
}

export function updateTodoPanel(panel: HTMLDetailsElement, todos: ChatTodo[]): void {
  const count = panel.querySelector('.chat-turn-todos__count')!;
  const completed = todos.filter(item => item.status === 'completed').length;
  const progress = `${completed} of ${todos.length} complete`;
  if (panel.classList.contains('chat-todo-panel')) {
    const visible = document.createElement('span');
    visible.setAttribute('aria-hidden', 'true');
    visible.textContent = `${completed}/${todos.length}`;
    const accessible = document.createElement('span');
    accessible.className = 'visually-hidden';
    accessible.textContent = progress;
    count.replaceChildren(visible, accessible);
  } else {
    count.textContent = progress;
  }
  const list = panel.querySelector('.chat-turn-todos__list')!;
  const scrollTop = list.scrollTop;
  const rows = [];
  for (const item of todos) {
    const row = document.createElement('li');
    row.className = `chat-turn-todos__item chat-turn-todos__item--${item.status}`;
    const glyph = document.createElement('span');
    glyph.className = 'chat-turn-todos__glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '●' : '○';
    const status = document.createElement('span');
    status.className = 'visually-hidden';
    status.textContent = `${item.status.replace('_', ' ')}: `;
    const text = document.createElement('span');
    text.textContent = item.text;
    row.append(glyph, status, text);
    rows.push(row);
  }
  list.replaceChildren(...rows);
  list.scrollTop = scrollTop;
}
