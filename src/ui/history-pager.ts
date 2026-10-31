import { isRenderIdle, subscribeRenderIdle } from '../boot/render-idle';

const PAGE_SIZE = 30;
const SLICE_MS = 6;
const LOAD_DISTANCE_PX = 160;

interface HistoryPagerOptions {
  mount: HTMLElement;
  scrollRoot: () => HTMLElement | null;
  from: number;
  renderRow: (host: HTMLElement, index: number) => void;
  onPageLoaded?: () => void;
}

/** Older history is work the reader requests, never work competing with a new chat's paint. */
export function mountHistoryPager(options: HistoryPagerOptions): () => void {
  const { mount, scrollRoot, renderRow, onPageLoaded } = options;
  mount.dataset.historyStart = String(options.from);
  if (options.from <= 0) return () => {};
  const view = mount.ownerDocument.defaultView!;
  const button = mount.ownerDocument.createElement('button');
  button.type = 'button';
  button.className = 'chat-history-more';
  button.textContent = 'Show earlier messages';
  mount.prepend(button);
  let end = options.from;
  let disposed = false;
  let loading = false;
  let interested = false;
  let cancelSlice: (() => void) | undefined;
  let unwatchIdle: (() => void) | undefined;

  function schedule(step: () => void): void {
    if (disposed) return;
    if (isRenderIdle()) {
      unwatchIdle = subscribeRenderIdle(idle => {
        if (idle) return;
        unwatchIdle?.(); unwatchIdle = undefined;
        schedule(step);
      });
      return;
    }
    const handle = view.requestAnimationFrame(step);
    cancelSlice = () => view.cancelAnimationFrame(handle);
  }

  function load(): void {
    if (disposed || loading || end <= 0 || !mount.isConnected) return;
    loading = true;
    interested = false;
    const requestedWithFocus = mount.ownerDocument.activeElement === button;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    const chunk = mount.ownerDocument.createElement('div');
    const start = Math.max(0, end - PAGE_SIZE);
    let index = end;
    const step = () => {
      cancelSlice = undefined;
      if (disposed || !mount.isConnected) return;
      if (isRenderIdle()) { schedule(step); return; }
      const started = performance.now();
      do {
        index -= 1;
        const row = mount.ownerDocument.createElement('div');
        renderRow(row, index);
        chunk.prepend(...row.childNodes);
      } while (index > start && performance.now() - started < SLICE_MS);
      if (index > start) { schedule(step); return; }

      // Resolve layout once per requested page, after every construction slice is finished.
      const root = scrollRoot();
      const top = root?.scrollTop ?? 0;
      const height = root?.scrollHeight ?? 0;
      const focusEarlier = requestedWithFocus && (mount.ownerDocument.activeElement === button ||
        mount.ownerDocument.activeElement === mount.ownerDocument.body);
      const first = chunk.firstElementChild as HTMLElement | null;
      button.after(...chunk.childNodes);
      end = start;
      mount.dataset.historyStart = String(start);
      loading = false;
      button.disabled = false;
      button.removeAttribute('aria-busy');
      if (end === 0) button.remove();
      onPageLoaded?.();
      if (root) {
        // A page insertion preserves the reader's anchor immediately, even on smooth-scroll hosts.
        const behavior = root.style.scrollBehavior;
        root.style.scrollBehavior = 'auto';
        root.scrollTop = top + root.scrollHeight - height;
        root.style.scrollBehavior = behavior;
      }
      if (end === 0 && focusEarlier && first) {
        if (!first.hasAttribute('tabindex')) first.tabIndex = -1;
        first.focus({ preventScroll: true });
      } else if (focusEarlier) button.focus({ preventScroll: true });
    };
    schedule(step);
  }

  const root = scrollRoot() ?? mount;
  const nearTop = () => {
    if (interested && root.scrollTop <= LOAD_DISTANCE_PX) load();
  };
  const wheel = (event: WheelEvent) => {
    if (event.deltaY < 0) { interested = true; nearTop(); }
  };
  const key = (event: KeyboardEvent) => {
    if (['Home', 'PageUp', 'ArrowUp'].includes(event.key)) { interested = true; nearTop(); }
  };
  const touch = () => { interested = true; };
  button.addEventListener('click', load);
  root.addEventListener('scroll', nearTop, { passive: true });
  root.addEventListener('wheel', wheel, { passive: true });
  root.addEventListener('keydown', key);
  root.addEventListener('touchmove', touch, { passive: true });
  root.addEventListener('pointerdown', touch, { passive: true });
  return () => {
    disposed = true;
    cancelSlice?.();
    unwatchIdle?.();
    root.removeEventListener('scroll', nearTop);
    root.removeEventListener('wheel', wheel);
    root.removeEventListener('keydown', key);
    root.removeEventListener('touchmove', touch);
    root.removeEventListener('pointerdown', touch);
    button.removeEventListener('click', load);
    button.remove();
  };
}
