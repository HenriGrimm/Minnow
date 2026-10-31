import { randomUUID } from 'node:crypto';
import { ChatContractError } from './contracts.js';

/**
 * Durable at-least-once outbox dispatch. Handlers must use the entry identity
 * to make their journal/external operation idempotent; a lease is not exactly-once.
 * No timers or provider calls: boot/runtime owns when to request a drain.
 */
export function createChatOutbox({ repository, handlers, ownerId = randomUUID(), leaseMs = 30000 }) {
  if (!repository || !handlers || typeof handlers !== 'object') throw new TypeError('Outbox repository and handlers are required');
  const inFlight = new Set();
  return {
    async drain({ limit = 100 } = {}) {
      const summary = { applied: 0, failed: 0, skipped: 0 };
      for (const entry of repository.listOutbox({ limit })) {
        const handler = Object.hasOwn(handlers, entry.kind) ? handlers[entry.kind] : null;
        if (typeof handler !== 'function') { summary.skipped += 1; continue; }
        if (inFlight.has(entry.outboxId)) { summary.skipped += 1; continue; }
        const claim = entry.state === 'applying' && entry.ownerId === ownerId ? entry : repository.claimOutbox(entry.outboxId, ownerId, leaseMs);
        if (!claim) { summary.skipped += 1; continue; }
        inFlight.add(entry.outboxId);
        try {
          let failure = null;
          try {
            await handler(claim);
          } catch (error) {
            failure = error instanceof ChatContractError ? error.toJSON()
              : { code: 'internal_error', message: 'Outbox operation failed', retryable: true };
          }
          // Database failures propagate. An external success without a durable
          // acknowledgement must remain eligible for the same idempotent replay.
          repository.finishOutbox(claim.outboxId, claim, failure);
          if (failure) summary.failed += 1;
          else summary.applied += 1;
        } finally { inFlight.delete(entry.outboxId); }
      }
      return summary;
    },
  };
}
