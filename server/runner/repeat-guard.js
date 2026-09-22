/**
 * Repeated-tool-call guard.
 *
 * A model that issues the same call and keeps getting the same answer is not
 * making progress — one board attempt alternated two identical commands 466
 * times before its budget ran out. The key includes the result, so re-running
 * `npm test` after an edit (different output) never counts; only a call that
 * cannot tell the model anything new does.
 *
 * Pure JS, no Node imports: the runner is shared with the browser bundle.
 */

/** How many recent calls are remembered. */
export const REPEAT_WINDOW = 40;

/** From this many identical call+result pairs in the window, the result carries a warning. */
export const REPEAT_WARN_AT = 3;

/**
 * Calls whose value is the side effect, not a novel response body. Navigating
 * to the current URL deliberately reloads the page and is a normal way to
 * reset app state between browser checks, so identical results do not imply a
 * stuck model.
 */
const REPEAT_GUARD_EXEMPT_TOOLS = new Set(['browser_navigate']);

/** FNV-1a — cheap, deterministic, good enough to compare results. */
function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * @param {string} name
 * @param {string} args raw JSON arguments
 * @param {string} content tool result text
 * @returns {string}
 */
export function repeatKey(name, args, content) {
  let canonicalArgs = typeof args === 'string' ? args.trim() : '';
  try {
    canonicalArgs = JSON.stringify(JSON.parse(canonicalArgs));
  } catch {
  }
  const text = typeof content === 'string' ? content : '';
  return `${name}\u0000${canonicalArgs}\u0000${text.length}:${hashText(text)}`;
}

/**
 * @param {{ maxRepeats?: number | null }} [options] `maxRepeats` ends the turn
 *   once one call+result pair reaches that count in the window. Omit to only warn
 *   (chat, where a person is watching).
 */
export function createRepeatGuard(options = {}) {
  const maxRepeats =
    typeof options.maxRepeats === 'number' && options.maxRepeats > REPEAT_WARN_AT
      ? options.maxRepeats
      : null;
  /** @type {string[]} */
  const recent = [];

  return {
    /**
     * Record one finished call.
     * @param {string} name
     * @param {string} args
     * @param {string} content
     * @returns {{ count: number, warning: string | null, stop: boolean }}
     */
    note(name, args, content) {
      if (REPEAT_GUARD_EXEMPT_TOOLS.has(name)) {
        return { count: 0, warning: null, stop: false };
      }
      const key = repeatKey(name, args, content);
      recent.push(key);
      if (recent.length > REPEAT_WINDOW) recent.shift();
      let count = 0;
      for (const k of recent) if (k === key) count += 1;
      if (count < REPEAT_WARN_AT) return { count, warning: null, stop: false };
      const stop = maxRepeats !== null && count >= maxRepeats;
      const warning =
        `[Minnow: this exact ${name} call has returned this same result ${count} times ` +
        `in your last ${recent.length} calls. Repeating it will not change the outcome. ` +
        'Change approach — read the error, try a different command, or report that you are blocked' +
        (maxRepeats !== null && !stop ? `; at ${maxRepeats} repeats this attempt is stopped.]` : '.]');
      return { count, warning, stop };
    },
  };
}

/** Error thrown when an unattended turn is stopped for looping. */
export class RepeatedToolCallError extends Error {
  /**
   * @param {string} name
   * @param {string} args
   * @param {number} count
   */
  constructor(name, args, count) {
    const shown = typeof args === 'string' && args.length > 200 ? `${args.slice(0, 200)}…` : args;
    super(
      `stopped: repeated the same ${name} call ${count} times with the same result (${shown})`,
    );
    this.name = 'RepeatedToolCallError';
  }
}
