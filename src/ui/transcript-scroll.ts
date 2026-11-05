/** One owner for each transcript's follow state and programmatic scroll writes. */
const END_TOLERANCE_PX = 1;
const TOUCH_INTENT_PX = 2;

export interface TranscriptScrollAnchor {
  pinned: boolean;
  distanceFromBottom: number;
}

export function transcriptBottomDistance(root: HTMLElement): number {
  return Math.max(0, root.scrollHeight - root.clientHeight - root.scrollTop);
}

const controllers = new WeakMap<HTMLElement, TranscriptScroller>();

export function getTranscriptScroller(root: HTMLElement): TranscriptScroller {
  let controller = controllers.get(root);
  if (!controller) {
    controller = new TranscriptScroller(root);
    controllers.set(root, controller);
  }
  return controller;
}

class TranscriptScroller {
  private pinned = true;
  private intent: 'up' | 'down' | null = null;
  private lastDirection: 'up' | 'down' | null = null;
  private position: { top: number; height: number; viewport: number };
  private listeners = new Set<() => void>();
  private scrubbing = false;
  private touchY: number | null = null;

  constructor(private root: HTMLElement) {
    this.position = this.readPosition();
    root.addEventListener('scroll', () => this.onScroll(), { passive: true });
    root.addEventListener('scrollend', () => {
      if (this.lastDirection === 'down' && this.atEnd()) this.pinned = true;
      this.notify();
    }, { passive: true });
    root.addEventListener('wheel', event => {
      if (event.deltaY) this.userIntent(event.deltaY < 0 ? 'up' : 'down');
    }, { passive: true });
    root.addEventListener('keydown', event => {
      if (['Home', 'PageUp', 'ArrowUp'].includes(event.key)) this.userIntent('up');
      else if (['End', 'PageDown', 'ArrowDown'].includes(event.key)) this.userIntent('down');
    });
    root.addEventListener('touchstart', event => {
      this.touchY = event.touches.length === 1 ? event.touches[0].clientY : null;
    }, { passive: true });
    root.addEventListener('touchmove', event => {
      if (this.touchY === null || event.touches.length !== 1) return;
      const y = event.touches[0].clientY;
      const delta = this.touchY - y;
      if (Math.abs(delta) <= TOUCH_INTENT_PX) return;
      this.touchY = y;
      this.userIntent(delta < 0 ? 'up' : 'down');
    }, { passive: true });
    const endTouch = () => { this.touchY = null; };
    root.addEventListener('touchend', endTouch, { passive: true });
    root.addEventListener('touchcancel', endTouch, { passive: true });
    root.addEventListener('pointerdown', event => {
      if (event.pointerType === 'touch' || this.scrubbing) return;
      this.scrubbing = true;
      const doc = root.ownerDocument;
      const view = doc.defaultView;
      const end = () => {
        this.scrubbing = false;
        doc.removeEventListener('pointerup', end, true);
        doc.removeEventListener('pointercancel', end, true);
        view?.removeEventListener('blur', end);
      };
      doc.addEventListener('pointerup', end, true);
      doc.addEventListener('pointercancel', end, true);
      view?.addEventListener('blur', end);
    });
    root.addEventListener('load', () => this.follow(), true);
  }

  subscribe(listener: () => void): void { this.listeners.add(listener); }
  isPinned(): boolean { return this.pinned; }
  private atEnd(): boolean { return transcriptBottomDistance(this.root) <= END_TOLERANCE_PX; }
  private notify(): void { for (const listener of this.listeners) listener(); }
  private readPosition() {
    return { top: this.root.scrollTop, height: this.root.scrollHeight, viewport: this.root.clientHeight };
  }

  private userIntent(direction: 'up' | 'down'): void {
    this.intent = this.lastDirection = direction;
    this.pinned = direction === 'down' && this.atEnd();
    this.notify();
  }

  private onScroll(): void {
    const previous = this.position;
    const next = this.position = this.readPosition();
    const sameLayout = next.height === previous.height && next.viewport === previous.viewport;
    const up = next.top < previous.top;
    const down = next.top > previous.top;
    const intent = this.intent;
    this.intent = null;
    if (intent === 'up' || up && (sameLayout || this.scrubbing)) {
      this.pinned = false;
      this.lastDirection = 'up';
    } else if (intent === 'down' || this.scrubbing || down && sameLayout) {
      this.pinned = this.atEnd();
      this.lastDirection = 'down';
    } else if (this.pinned && !this.atEnd()) {
      this.writeTo(this.root.scrollHeight);
    }
    this.notify();
  }

  /** Explicit instant operations avoid CSS smooth-scroll overrides and delayed release flags. */
  private writeTo(top: number): void {
    this.root.scrollTo({ top, behavior: 'instant' });
    this.position = this.readPosition();
  }

  private shiftBy(delta: number): void {
    if (Math.abs(delta) > 0.01) this.root.scrollBy({ top: delta, behavior: 'instant' });
    this.position = this.readPosition();
  }

  pin(): void {
    this.pinned = true;
    this.intent = this.lastDirection = null;
    this.position = this.readPosition();
    this.notify();
  }

  toBottom(): void {
    this.pin();
    this.writeTo(this.root.scrollHeight);
    this.notify();
  }

  follow(): void {
    if (this.pinned && !this.atEnd()) this.writeTo(this.root.scrollHeight);
    this.notify();
  }

  capture(): TranscriptScrollAnchor {
    return { pinned: this.pinned, distanceFromBottom: transcriptBottomDistance(this.root) };
  }

  restore(anchor: TranscriptScrollAnchor): void {
    this.pinned = anchor.pinned;
    this.intent = this.lastDirection = null;
    const max = Math.max(0, this.root.scrollHeight - this.root.clientHeight);
    this.writeTo(anchor.pinned ? this.root.scrollHeight : Math.max(0, max - anchor.distanceFromBottom));
    this.notify();
  }

  /** Apply a prepend/disclosure change and its scroll policy as one synchronous operation. */
  preserve(mount: HTMLElement, mutate: () => void): void {
    if (this.pinned) {
      mutate();
      this.writeTo(this.root.scrollHeight);
      this.notify();
      return;
    }
    const height = this.root.scrollHeight;
    const viewport = this.root.getBoundingClientRect();
    const scale = this.root.offsetHeight > 0 ? viewport.height / this.root.offsetHeight : 1;
    // Work buttons can move to an older tool row during grouping; anchor a message instead.
    let hit = viewport.width > 0 ? this.root.ownerDocument.elementFromPoint?.(
      viewport.left + viewport.width / 2, viewport.top + Math.min(24, viewport.height / 2),
    ) : null;
    while (hit && hit.parentElement !== mount) hit = hit.parentElement;
    const anchor = hit?.hasAttribute('data-history-index') ? hit : Array.from(mount.children).find(node => {
      if (!node.hasAttribute('data-history-index')) return false;
      const rect = node.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    const top = anchor?.getBoundingClientRect().top;
    mutate();
    if (anchor?.isConnected && top != null && anchor.getBoundingClientRect().height > 0) {
      this.shiftBy((anchor.getBoundingClientRect().top - top) / (scale || 1));
    } else this.shiftBy(this.root.scrollHeight - height);
    this.notify();
  }
}
