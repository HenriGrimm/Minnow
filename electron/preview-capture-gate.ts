/**
 * Tracks in-flight `capturePage` copies per preview guest. Resizing a surface to
 * 0x0 or detaching it while Chromium copies it can hang macOS WindowServer, so
 * those steps wait for the guest's captures to settle.
 */
export interface PreviewCaptureGate {
  /** Register a capture for `key`; resolves or rejects exactly like `capture`. */
  track<T>(key: object, capture: Promise<T>): Promise<T>;
  /** Resolves once no capture for `key` is in flight, including ones tracked while waiting. */
  whenIdle(key: object): Promise<void>;
  inFlight(key: object): number;
}

export function createPreviewCaptureGate(): PreviewCaptureGate {
  const pending = new WeakMap<object, Set<Promise<void>>>();

  return {
    track(key, capture) {
      let captures = pending.get(key);
      if (!captures) {
        captures = new Set();
        pending.set(key, captures);
      }
      const settled = capture.then(() => undefined, () => undefined);
      captures.add(settled);
      const owner = captures;
      void settled.then(() => {
        owner.delete(settled);
        if (owner.size === 0 && pending.get(key) === owner) pending.delete(key);
      });
      return capture;
    },
    async whenIdle(key) {
      for (;;) {
        const captures = pending.get(key);
        if (!captures || captures.size === 0) return;
        await Promise.all([...captures]);
      }
    },
    inFlight(key) {
      return pending.get(key)?.size ?? 0;
    },
  };
}
