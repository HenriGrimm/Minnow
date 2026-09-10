/**
 * The Agent Browser viewer is a single auxiliary window. Keeping this tiny
 * lifecycle separate from Electron lets its close/open race behaviour be
 * tested without loading a desktop runtime.
 */
export interface ViewerWindowLike {
  isDestroyed(): boolean;
}

export class SingleViewerWindow<T extends ViewerWindowLike> {
  private current: T | null = null;
  private opening: Promise<{ ok: true; focused: boolean } | { ok: false; error: string }> | null = null;

  live(): T | null {
    if (this.current?.isDestroyed()) this.current = null;
    return this.current;
  }

  set(window: T): void {
    this.current = window;
  }

  clear(window: T): void {
    if (this.current === window) this.current = null;
  }

  begin(
    open: () => Promise<{ ok: true; focused: boolean } | { ok: false; error: string }>,
  ): Promise<{ ok: true; focused: boolean } | { ok: false; error: string }> {
    if (this.opening) return this.opening;
    const opening = open();
    this.opening = opening;
    void opening.finally(() => {
      if (this.opening === opening) this.opening = null;
    });
    return opening;
  }
}
