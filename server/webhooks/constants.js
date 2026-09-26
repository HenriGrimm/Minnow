/**
 * Outgoing webhook event names and delivery limits.
 */

/** Events that may be subscribed to (webhook.test is test-only, not subscribable). */
export const SUBSCRIBABLE_EVENTS = [
  'chat.completed',
  'session.created',
  'scheduler.job_completed',
];

/** All events the delivery worker may emit (includes test-fire). */
export const ALLOWED_EVENTS = [...SUBSCRIBABLE_EVENTS, 'webhook.test'];

/** @param {string} event */
export function isAllowedEvent(event) {
  return typeof event === 'string' && ALLOWED_EVENTS.includes(event);
}

/** @param {string} event */
export function isSubscribableEvent(event) {
  return typeof event === 'string' && SUBSCRIBABLE_EVENTS.includes(event);
}

/** Total queued, running, and delayed-retry deliveries retained in memory. */
export const MAX_PENDING_DELIVERIES = 100;
export const MAX_DELIVERY_LOG = 200;
export const DELIVERY_TIMEOUT_MS = 10_000;
export const RETRY_BACKOFF_MS = [1_000, 4_000, 16_000];
export const MAX_DELIVERY_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;
