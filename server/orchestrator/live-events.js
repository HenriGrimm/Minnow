/** Live attempt, error, and deliver event buses. */

/**
 * @typedef {object} LiveAttemptEvent
 * @property {string} [key]
 * @property {string} boardId
 * @property {string} attemptId
 * @property {string | null} taskId
 * @property {string} role
 * @property {number} [roundIndex]
 * @property {import('../runner/run-turn').TurnEvent} event
 */

/** @type {Map<string, Set<(payload: LiveAttemptEvent) => void>>} */
const listeners = new Map();

/**
 * @param {{ key?: string, boardId: string }} payload
 * @returns {string}
 */
function routingKey(payload) {
  return payload.key ?? payload.boardId;
}

/**
 * @param {string} key
 * @param {(payload: LiveAttemptEvent) => void} handler
 * @returns {() => void}
 */
export function subscribeLive(key, handler) {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0) listeners.delete(key);
  };
}

/**
 * @param {LiveAttemptEvent} payload
 * @returns {void}
 */
export function emitLive(payload) {
  const set = listeners.get(routingKey(payload));
  if (!set) return;
  for (const handler of set) {
    try {
      handler(payload);
    } catch {
    }
  }
}


/**
 * Failures that stop work from *starting*, on the way to the screen.
 * @typedef {object} BoardErrorEvent
 * @property {string} [key]  opaque routing key; omitted on board events
 * @property {string} boardId
 * @property {string | null} taskId
 * @property {string} role
 * @property {string} message
 * @property {number} consecutive  how many times this has failed in a row
 */

/** @type {Map<string, Set<(payload: BoardErrorEvent) => void>>} */
const errorListeners = new Map();

/**
 * @param {string} key  opaque. Boards pass boardId.
 * @param {(payload: BoardErrorEvent) => void} handler
 * @returns {() => void}
 */
export function subscribeErrors(key, handler) {
  let set = errorListeners.get(key);
  if (!set) {
    set = new Set();
    errorListeners.set(key, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0) errorListeners.delete(key);
  };
}

/**
 * @param {BoardErrorEvent} payload
 * @returns {void}
 */
export function emitError(payload) {
  const set = errorListeners.get(routingKey(payload));
  if (!set) return;
  for (const handler of set) {
    try {
      handler(payload);
    } catch {
    }
  }
}


/**
 * A pending parent-chat inject, on the way to the renderer.
 * @typedef {object} DeliverEvent
 * @property {string} [key]
 * @property {string} parentChatId
 * @property {'completion' | 'check_in_nudge'} kind
 * @property {string[]} runIds
 * @property {string} message
 */

/** @type {Map<string, Set<(payload: DeliverEvent) => void>>} */
const deliverListeners = new Map();

/**
 * @param {string} key  opaque. Agents pass parentChatId.
 * @param {(payload: DeliverEvent) => void} handler
 * @returns {() => void}
 */
export function subscribeDeliver(key, handler) {
  let set = deliverListeners.get(key);
  if (!set) {
    set = new Set();
    deliverListeners.set(key, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0) deliverListeners.delete(key);
  };
}

/**
 * @param {DeliverEvent} payload
 * @returns {number} how many listeners received the frame
 */
export function emitDeliver(payload) {
  const key = payload.key ?? payload.parentChatId;
  const set = deliverListeners.get(key);
  if (!set || set.size === 0) return 0;
  for (const handler of set) {
    try {
      handler(payload);
    } catch {
    }
  }
  return set.size;
}
