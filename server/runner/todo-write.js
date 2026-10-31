const MAX_TODO_ITEMS = 20;
const MAX_TODO_TEXT_CHARS = 140;

function coerceToolArrayField(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
      if (typeof parsed === 'object' && parsed !== null) return [parsed];
      return null;
    } catch { return null; }
  }
  if (value && typeof value === 'object') {
    if ('item' in value) return coerceToolArrayField(value.item);
    if ('items' in value) return coerceToolArrayField(value.items);
  }
  return null;
}

export function normalizeTodoStatus(raw) {
  if (typeof raw !== 'string') return 'pending';
  const value = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!value) return 'pending';
  if (/^(done|complete|completed|finished|finish)$/.test(value)) return 'completed';
  if (/^(active|current|doing|in_progress|inprogress|working|progress)$/.test(value)) return 'in_progress';
  if (/^(todo|open|not_started|notstarted|pending|waiting)$/.test(value)) return 'pending';
  if (value === 'completed' || value === 'in_progress' || value === 'pending') return value;
  return 'pending';
}

export function normalizeTodoWriteArgs(args) {
  const todos = coerceToolArrayField(args.todos);
  return { ...args, ...(todos ? { todos } : {}) };
}

/** The shared renderer/server validator; tolerant model coercion stays identical. */
export function validateTodoWriteArgs(args) {
  const normalized = normalizeTodoWriteArgs(args);
  const rawTodos = normalized.todos;
  if (!Array.isArray(rawTodos)) return { ok: false, error: 'Error: todo_write requires "todos" array' };
  const parsed = [];
  for (const item of rawTodos.slice(0, MAX_TODO_ITEMS)) {
    if (!item || typeof item !== 'object') continue;
    const text = (typeof item.text === 'string' ? item.text : String(item.text ?? '')).trim().slice(0, MAX_TODO_TEXT_CHARS);
    if (text) parsed.push({ text, status: normalizeTodoStatus(item.status) });
  }
  let sawInProgress = false;
  const todos = parsed.map(item => {
    if (item.status !== 'in_progress') return item;
    if (!sawInProgress) { sawInProgress = true; return item; }
    return { ...item, status: 'pending' };
  });
  return { ok: true, args: { todos } };
}

export function formatTodoProgress(todos) {
  return `${todos.filter(todo => todo.status === 'completed').length}/${todos.length}`;
}
