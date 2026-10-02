/**
 * Boot resume gate for orchestrate boards.
 */

/**
 * @typedef {object} PendingBoardResume
 * @property {string} boardId
 * @property {() => void} resume
 * @property {() => Promise<void>} decline
 * @property {() => { name?: string, tasks?: Map<string, unknown> | unknown[] }} peek
 */

let armed = false;

/** @type {Map<string, PendingBoardResume>} */
const pending = new Map();

/**
 * Boards already answered in this process.
 * @type {Set<string>}
 */
const resolved = new Set();

/** Arm the gate. Production boot only — see the module note. */
export function armBoardResumeGate() {
  armed = true;
}

/** @returns {boolean} */
export function isBoardResumeGateArmed() {
  return armed;
}

/**
 * True when `load()` must hold this board instead of starting its timer.
 *
 * @param {string} boardId
 * @returns {boolean}
 */
export function shouldHoldBoardResume(boardId) {
  return armed && !resolved.has(boardId);
}

/**
 * Register a board held at load.
 *
 * @param {PendingBoardResume} entry
 * @returns {void}
 */
export function holdBoardResume(entry) {
  pending.set(entry.boardId, entry);
}

/** A disposed board must not remain in the boot resume prompt. */
export function forgetBoardResume(boardId) {
  pending.delete(boardId);
  resolved.delete(boardId);
}

/**
 * Boards waiting on an answer, as prompt rows.
 * @returns {Array<{ boardId: string, name: string, taskCount: number }>}
 */
export function listPendingBoardResumes() {
  const rows = [];
  for (const entry of pending.values()) {
    let name = '';
    let taskCount = 0;
    try {
      const state = entry.peek();
      name = typeof state?.name === 'string' ? state.name : '';
      const raw = state?.tasks;
      taskCount = raw instanceof Map ? raw.size : Array.isArray(raw) ? raw.length : 0;
    } catch {
    }
    rows.push({ boardId: entry.boardId, name, taskCount });
  }
  return rows;
}

/**
 * Answer one board.
 * @param {string} boardId
 * @param {'resume' | 'decline'} decision
 * @returns {Promise<boolean>} false when nothing was pending for that id
 */
export async function resolveBoardResume(boardId, decision) {
  const entry = pending.get(boardId);
  if (!entry) return false;
  pending.delete(boardId);
  resolved.add(boardId);
  if (decision === 'resume') entry.resume();
  else await entry.decline();
  return true;
}

/**
 * @param {'resume' | 'decline'} decision
 * @returns {Promise<string[]>}
 */
export async function resolveAllBoardResumes(decision) {
  const ids = [...pending.keys()];
  for (const boardId of ids) {
    await resolveBoardResume(boardId, decision);
  }
  return ids;
}

export function resetBoardResumeGateForTests() {
  armed = false;
  pending.clear();
  resolved.clear();
}
