/** A failed heartbeat is uncertainty, not evidence that another renderer owns the chat. */
export class ChatOwnershipError extends Error {
  readonly name = 'ChatOwnershipError';
  constructor(readonly kind: 'lost' | 'unavailable', readonly chatId: string) {
    super(kind === 'lost'
      ? 'This chat is now owned by another window. Continue from that window, or retry when it finishes.'
      : 'Could not confirm chat ownership before its lease expired. Check the connection and continue from the saved work.');
  }
}

export class ChatLeaseRequestError extends Error {
  constructor(readonly retryable: boolean) { super('Could not check which device is running this chat.'); }
}

export interface LeaseGrant { leaseMs: number; startedAt: number }

export function createTurnLease(options: {
  chatId: string;
  grant: LeaseGrant;
  request: (signal: AbortSignal) => Promise<LeaseGrant | null>;
  release: () => Promise<void>;
  now?: () => number;
  diagnose?: (event: string) => void;
}) {
  const now = options.now ?? (() => performance.now());
  const controller = new AbortController();
  let deadline = options.grant.startedAt + options.grant.leaseMs;
  let renewedAt = options.grant.startedAt;
  let nextRenewAt = renewedAt + 5_000;
  let released = false;
  let failures = 0;
  let renewing: Promise<void> | null = null;
  let requestController: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout>;
  let expiryTimer: ReturnType<typeof setTimeout>;
  const fail = (kind: 'lost' | 'unavailable') => {
    if (released || controller.signal.aborted) return;
    clearTimeout(timer); clearTimeout(expiryTimer);
    controller.abort(new ChatOwnershipError(kind, options.chatId));
    requestController?.abort();
    options.diagnose?.(kind);
  };
  const expired = () => {
    if (now() >= deadline) fail('unavailable');
    return controller.signal.aborted;
  };
  const armExpiry = () => {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => { if (!expired()) armExpiry(); }, Math.max(0, deadline - now()));
  };
  const schedule = () => {
    clearTimeout(timer);
    if (released || controller.signal.aborted) return;
    const delay = failures ? Math.min(5_000, 1_000 * 2 ** Math.min(failures - 1, 3)) * (0.9 + Math.random() * 0.1) : 5_000;
    nextRenewAt = now() + delay;
    timer = setTimeout(() => { void renew(); }, Math.min(delay, Math.max(0, deadline - now())));
  };
  const renew = (): Promise<void> => {
    if (renewing) return renewing;
    if (released || expired()) return Promise.resolve();
    requestController = new AbortController();
    renewing = (async () => {
      try {
        const grant = await options.request(requestController!.signal);
        if (released || expired()) return;
        if (!grant) { fail('lost'); return; }
        // The server grant begins no later than request dispatch, not response receipt.
        deadline = grant.startedAt + grant.leaseMs;
        renewedAt = grant.startedAt;
        if (expired()) return;
        if (failures) options.diagnose?.('recovered');
        failures = 0;
        armExpiry();
      } catch (error) {
        if (released || controller.signal.aborted) return;
        if (error instanceof ChatLeaseRequestError && !error.retryable) { fail('unavailable'); return; }
        failures++;
        if (failures === 1) options.diagnose?.('renewal-failed');
        expired();
      } finally {
        renewing = null; requestController = null;
        schedule();
      }
    })();
    return renewing;
  };
  armExpiry(); schedule();
  return {
    signal: controller.signal,
    async check() {
      if (!released && !expired() && now() >= nextRenewAt) await renew();
      if (released) throw new ChatOwnershipError('unavailable', options.chatId);
      if (expired()) throw controller.signal.reason;
    },
    async release() {
      if (released) return;
      released = true;
      clearTimeout(timer); clearTimeout(expiryTimer);
      requestController?.abort();
      // Do not wait for a fetch implementation which ignores cancellation.
      await options.release();
    },
  };
}
