/** Keep only the latest drag position per frame; flush before committing on release. */
export function createPointerFrame(paint: (clientX: number) => void): {
  schedule: (clientX: number) => void;
  flush: () => void;
} {
  let frame: number | null = null;
  let latest: number | null = null;
  const flush = (): void => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    if (latest === null) return;
    const value = latest;
    latest = null;
    paint(value);
  };
  return {
    schedule(clientX) {
      latest = clientX;
      if (frame === null) frame = window.requestAnimationFrame(flush);
    },
    flush,
  };
}
