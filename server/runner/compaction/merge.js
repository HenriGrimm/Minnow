/**
 * Merge rules for {@link CompactionState}. Sticky sections keep their first
 * value, union sections accumulate (capped, oldest out), volatile sections
 * take the latest value. Every helper returns a new value and orders output by
 * first appearance, so the same rows always produce the same bytes.
 */

/** Rolling caps on what the state remembers (the formatter trims further to fit its budget). */
export const STATE_CAPS = Object.freeze({
  scopeChanges: 4,
  notes: 8,
  findings: 12,
  files: 80,
  commits: 8,
  subAgents: 10,
  turns: 40,
  problems: 12,
  todos: 30,
});

/** @returns {import('./index').CompactionState} */
export function emptyCompactionState() {
  return {
    version: 1,
    goal: '',
    scopeChanges: [],
    notes: [],
    findings: [],
    files: [],
    commits: [],
    subAgents: [],
    turns: [],
    problems: [],
    todos: [],
    status: { lastAssistant: '', lastFileAction: '', lastCommand: '' },
    folded: { fromRow: null, throughRow: null, turns: 0, rows: 0 },
  };
}

/**
 * Deep copy of a (possibly persisted, possibly partial) state.
 * @param {unknown} raw
 * @returns {import('./index').CompactionState}
 */
export function cloneCompactionState(raw) {
  const base = emptyCompactionState();
  if (!raw || typeof raw !== 'object') return base;
  const s = /** @type {Record<string, any>} */ (raw);
  const arr = (v) => (Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? { ...x } : x)) : []);
  return {
    version: 1,
    goal: typeof s.goal === 'string' ? s.goal : '',
    scopeChanges: arr(s.scopeChanges),
    notes: Array.isArray(s.notes) ? s.notes.filter((n) => typeof n === 'string') : [],
    findings: arr(s.findings).slice(-STATE_CAPS.findings),
    files: arr(s.files).map((f) => ({ ...f, ops: Array.isArray(f.ops) ? [...f.ops] : [], observations: arr(f.observations).slice(-3) })),
    commits: arr(s.commits),
    subAgents: arr(s.subAgents),
    turns: arr(s.turns).map((t) => ({ ...t, tools: t.tools && typeof t.tools === 'object' ? { ...t.tools } : {} })),
    problems: arr(s.problems),
    todos: Array.isArray(s.todos) ? s.todos.filter((t) => typeof t === 'string') : [],
    status: {
      lastAssistant: typeof s.status?.lastAssistant === 'string' ? s.status.lastAssistant : '',
      lastFileAction: typeof s.status?.lastFileAction === 'string' ? s.status.lastFileAction : '',
      lastCommand: typeof s.status?.lastCommand === 'string' ? s.status.lastCommand : '',
    },
    folded: {
      fromRow: Number.isFinite(s.folded?.fromRow) ? s.folded.fromRow : null,
      throughRow: Number.isFinite(s.folded?.throughRow) ? s.folded.throughRow : null,
      turns: Number.isFinite(s.folded?.turns) ? s.folded.turns : 0,
      rows: Number.isFinite(s.folded?.rows) ? s.folded.rows : 0,
    },
  };
}

/**
 * Append `item`, dropping the oldest entries past `cap`.
 * @template T
 * @param {T[]} list
 * @param {T} item
 * @param {number} cap
 */
export function pushCapped(list, item, cap) {
  list.push(item);
  while (list.length > cap) list.shift();
}

/**
 * Sticky, de-duplicated text list (first wins, oldest out past `cap`).
 * @param {string[]} list
 * @param {string} text
 * @param {number} cap
 */
export function addUniqueText(list, text, cap) {
  if (!text || list.includes(text)) return;
  pushCapped(list, text, cap);
}

const FILE_OP_ORDER = ['created', 'modified', 'deleted', 'moved', 'copied', 'read'];

/**
 * Union a file operation into the files section. Line stats accumulate.
 * @param {import('./index').CompactionState} state
 * @param {string} path
 * @param {string} op
 * @param {{ additions?: number, deletions?: number, row?: number | null }} [extra]
 */
export function noteFile(state, path, op, extra = {}) {
  const clean = String(path ?? '').trim();
  if (!clean) return;
  let entry = state.files.find((f) => f.path === clean);
  if (!entry) {
    entry = { path: clean, ops: [], additions: 0, deletions: 0, row: extra.row ?? null };
    state.files.push(entry);
    while (state.files.length > STATE_CAPS.files) {
      // Evict read-only files before anything that was changed.
      const readOnly = state.files.findIndex((f) => f.ops.every((o) => o === 'read'));
      state.files.splice(readOnly >= 0 ? readOnly : 0, 1);
    }
  }
  if (!entry.ops.includes(op)) {
    entry.ops.push(op);
    entry.ops.sort((a, b) => FILE_OP_ORDER.indexOf(a) - FILE_OP_ORDER.indexOf(b));
  }
  if (Number.isFinite(extra.additions)) entry.additions += Math.max(0, Math.floor(extra.additions));
  if (Number.isFinite(extra.deletions)) entry.deletions += Math.max(0, Math.floor(extra.deletions));
  if (extra.row != null) entry.row = extra.row;
  if (op !== 'read' && op !== 'copied') entry.observations = [];
}

/**
 * Open or resolve a problem keyed by tool + primary argument.
 * @param {import('./index').CompactionState} state
 * @param {string} key
 * @param {{ text: string, row: number | null, error: boolean }} next
 */
export function noteProblem(state, key, next) {
  const at = state.problems.findIndex((p) => p.key === key);
  if (!next.error) {
    if (at >= 0 && state.problems[at].status === 'open') {
      state.problems[at] = { ...state.problems[at], status: 'resolved', resolvedRow: next.row };
    }
    return;
  }
  if (at >= 0) state.problems.splice(at, 1);
  pushCapped(state.problems, { key, text: next.text, row: next.row, status: 'open' }, STATE_CAPS.problems);
}
