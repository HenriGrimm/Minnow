import { isRenderIdle, subscribeRenderIdle } from '../boot/render-idle';

const PAGE_SIZE = 30;
const SLICE_MS = 6;
const MIN_PRELOAD_DISTANCE_PX = 600;
const PRELOAD_VIEWPORTS = 2;

interface HistoryPagerOptions {
  mount: HTMLElement;
  scrollRoot: () => HTMLElement | null;
  from: number;
  renderRow: (host: HTMLElement, index: number) => void;
  /** Settle inserted rows synchronously before restoring the scroll anchor. */
  onPageLoaded?: () => void;
}

/** Load ahead of an upward-scrolling reader without competing with a new chat's paint. */
export function mountHistoryPager(options: HistoryPagerOptions): () => void {
  const { mount, scrollRoot, renderRow, onPageLoaded } = options;
  mount.dataset.historyStart = String(options.from);
  if (options.from <= 0) return () => {};
  const view = mount.ownerDocument.defaultView!;
  const root = scrollRoot() ?? mount;
  let end = options.from;
  let disposed = false;
  let loading = false;
  let interested = false;
  let fillingInitialBuffer = true;
  let lastTop = root.scrollTop;
  let touchY: number | undefined;
  let cancelSlice: (() => void) | undefined;
  let unwatchIdle: (() => void) | undefined;

  function schedule(step: () => void): void {
    if (disposed) return;
    cancelSlice?.(); cancelSlice = undefined;
    unwatchIdle?.(); unwatchIdle = undefined;
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
      const top = root.scrollTop;
      const height = root.scrollHeight;
      mount.prepend(...chunk.childNodes);
      end = start;
      mount.dataset.historyStart = String(start);
      onPageLoaded?.();
      // A page insertion preserves the reader's anchor immediately, even on smooth-scroll hosts.
      const behavior = root.style.scrollBehavior;
      root.style.scrollBehavior = 'auto';
      root.scrollTop = top + root.scrollHeight - height;
      root.style.scrollBehavior = behavior;
      lastTop = root.scrollTop;
      loading = false;
      // Tool-only pages can add no visible height in Compact view. Keep filling
      // the off-screen buffer until there is readable history ahead of the reader.
      nearTop();
    };
    schedule(step);
  }

  const nearTop = () => {
    const distance = Math.max(MIN_PRELOAD_DISTANCE_PX, root.clientHeight * PRELOAD_VIEWPORTS);
    if (root.scrollTop > distance) {
      fillingInitialBuffer = false;
      return;
    }
    if (interested || fillingInitialBuffer && root.clientHeight > 0) load();
  };
  const scroll = () => {
    const top = root.scrollTop;
    if (top !== lastTop) interested = top < lastTop;
    lastTop = top;
    nearTop();
  };
  const wheel = (event: WheelEvent) => {
    if (event.deltaY < 0) { interested = true; nearTop(); }
    else if (event.deltaY > 0) { interested = false; fillingInitialBuffer = false; }
  };
  const key = (event: KeyboardEvent) => {
    if (['Home', 'PageUp', 'ArrowUp'].includes(event.key)) { interested = true; nearTop(); }
    else if (['End', 'PageDown', 'ArrowDown'].includes(event.key)) { interested = false; fillingInitialBuffer = false; }
  };
  const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY; };
  const touchMove = (event: TouchEvent) => {
    const y = event.touches[0]?.clientY;
    if (y != null && touchY != null && y !== touchY) {
      interested = y > touchY;
      if (!interested) fillingInitialBuffer = false;
      nearTop();
    }
    touchY = y;
  };
  root.addEventListener('scroll', scroll, { passive: true });
  root.addEventListener('wheel', wheel, { passive: true });
  root.addEventListener('keydown', key);
  root.addEventListener('touchstart', touchStart, { passive: true });
  root.addEventListener('touchmove', touchMove, { passive: true });
  // Thirty stored entries may collapse to only a few visible rows. Build enough
  // scrollable history before the first gesture can hit that temporary boundary.
  schedule(() => { cancelSlice = undefined; nearTop(); });
  return () => {
    disposed = true;
    cancelSlice?.();
    unwatchIdle?.();
    root.removeEventListener('scroll', scroll);
    root.removeEventListener('wheel', wheel);
    root.removeEventListener('keydown', key);
    root.removeEventListener('touchstart', touchStart);
    root.removeEventListener('touchmove', touchMove);
  };
}
