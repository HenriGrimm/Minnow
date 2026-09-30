import {
  createDelivery,
  buildProductionParentMessage,
  NO_DELIVERY_LISTENER,
} from './delivery.js';
import {
  appendEvent,
  appendEvents,
  listEntries,
  loadState,
  readEvents,
} from './journal.js';
import { emitDeliver } from '../orchestrator/live-events.js';

/** @type {import('./delivery.js').DeliveryHandle | null} */
let production = null;

/** @type {(parentChatId: string) => import('./delivery.js').ParentStatus} */
let parentStatusProbe = () => ({ streaming: false, skip: null });

/**
 * @param {((parentChatId: string) => import('./delivery.js').ParentStatus) | null} [fn]
 * @returns {void}
 */
export function setProductionParentStatus(fn) {
  parentStatusProbe =
    typeof fn === 'function' ? fn : () => ({ streaming: false, skip: null });
}

/**
 * @returns {import('./delivery.js').DeliveryJournal}
 */
function diskJournal() {
  return {
    loadState,
    appendEvent,
    appendEvents,
    listEntries,
    readEvents,
  };
}

/**
 * Notify the renderer over the parallel (non-journaled) bus. Zero listeners
 * means the UI is not connected — throw so the fold stays pending.
 *
 * @param {string} parentChatId
 * @param {string} message
 * @param {import('./delivery.js').DeliveryMeta} meta
 * @returns {Promise<void>}
 */
async function productionDeliver(parentChatId, message, meta) {
  const n = emitDeliver({
    key: parentChatId,
    parentChatId,
    kind: meta.kind,
    runIds: meta.runIds,
    message,
  });
  if (n === 0) {
    throw new Error(NO_DELIVERY_LISTENER);
  }
}

/**
 * The process-wide delivery handle. Created once so boot `tickAll` and the
 * per-engine subscriber share one retry map.
 *
 * @returns {import('./delivery.js').DeliveryHandle}
 */
export function getProductionDelivery() {
  if (!production) {
    production = createDelivery({
      journal: diskJournal(),
      deliverToParent: productionDeliver,
      requiresAcceptanceAck: true,
      buildMessage: buildProductionParentMessage,
      parentStatus: (parentChatId) => parentStatusProbe(parentChatId),
      onDeliverError: (err) => {
        const message = err instanceof Error ? err.message : err;
        if (message === NO_DELIVERY_LISTENER) return;
        console.warn('[agents] delivery failed:', message);
      },
    });
  }
  return production;
}

/**
 * @returns {Promise<void>}
 */
export async function bootAgentsRuntime() {
  try {
    await getProductionDelivery().tickAll();
  } catch (err) {
    console.warn('[agents] boot tickAll failed:', err instanceof Error ? err.message : err);
  }
}

/** Tests: drop the process-wide handle so journals do not leak across cases. */
export function resetProductionDelivery() {
  production?.reset();
  production = null;
  parentStatusProbe = () => ({ streaming: false, skip: null });
}
