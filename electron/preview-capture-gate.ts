/**
 * Tracks in-flight `capturePage` copies per preview guest. Resizing a surface to
 * 0x0 or detaching it waits for native copies as a preventative surface-lifetime
 * race mitigation, not a proven fix for WindowServer hangs.
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

/** Shared by the raw-copy producer and native surface lifecycle. Keys are WebContents. */
export const previewCaptureGate = createPreviewCaptureGate();

/** Latest visibility intent wins, including over temporary capture reveals. */
export function createPreviewCaptureVisibility(gate: PreviewCaptureGate) {
  const intents = new WeakMap<object, object>();
  const change = (key: object): object => {
    const token = {};
    intents.set(key, token);
    return token;
  };
  const isCurrent = (key: object, token: object): boolean => intents.get(key) === token;
  return {
    change,
    isCurrent,
    hide(key: object, finish: () => void): void {
      const token = change(key);
      if (gate.inFlight(key) === 0) { finish(); return; }
      void gate.whenIdle(key).then(() => {
        if (isCurrent(key, token)) finish();
      });
    },
  };
}
