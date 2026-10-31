/**
 * Floating placement for popovers, tooltips and menus: prefer a side, flip to
 * the opposite side when the preferred one would clip, then clamp into the
 * viewport. The math is pure so it can be tested without layout.
 */

export type FloatingPlacement =
  | 'top'
  | 'top-start'
  | 'top-end'
  | 'bottom'
  | 'bottom-start'
  | 'bottom-end'
  | 'left'
  | 'right';

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface FloatingOptions {
  placement?: FloatingPlacement;
  /** Gap between anchor and floating element. */
  offset?: number;
  /** Minimum distance kept from the viewport edges. */
  edgeGap?: number;
}

export interface FloatingPosition {
  left: number;
  top: number;
  placement: FloatingPlacement;
}

type Side = 'top' | 'bottom' | 'left' | 'right';
type Align = 'start' | 'end' | undefined;

const OPPOSITE: Record<Side, Side> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

const DEFAULT_OFFSET = 4;
const DEFAULT_EDGE_GAP = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Where to put a `size` box next to `anchor` inside `viewport`. */
export function computeFloatingPosition(
  anchor: RectLike,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  options: FloatingOptions = {},
): FloatingPosition {
  const placement = options.placement ?? 'bottom-start';
  const offset = options.offset ?? DEFAULT_OFFSET;
  const gap = options.edgeGap ?? DEFAULT_EDGE_GAP;
  const [preferred, align] = placement.split('-') as [Side, Align];

  const fits = (side: Side): boolean => {
    switch (side) {
      case 'bottom':
        return anchor.bottom + offset + size.height + gap <= viewport.height;
      case 'top':
        return anchor.top - offset - size.height - gap >= 0;
      case 'right':
        return anchor.right + offset + size.width + gap <= viewport.width;
      case 'left':
        return anchor.left - offset - size.width - gap >= 0;
    }
  };

  const side = !fits(preferred) && fits(OPPOSITE[preferred]) ? OPPOSITE[preferred] : preferred;

  let left: number;
  let top: number;
  if (side === 'top' || side === 'bottom') {
    top = side === 'bottom' ? anchor.bottom + offset : anchor.top - offset - size.height;
    left =
      align === 'start'
        ? anchor.left
        : align === 'end'
          ? anchor.right - size.width
          : anchor.left + (anchor.width - size.width) / 2;
  } else {
    left = side === 'right' ? anchor.right + offset : anchor.left - offset - size.width;
    top = anchor.top + (anchor.height - size.height) / 2;
  }

  return {
    left: Math.round(clamp(left, gap, viewport.width - size.width - gap)),
    top: Math.round(clamp(top, gap, viewport.height - size.height - gap)),
    placement: (align ? `${side}-${align}` : side) as FloatingPlacement,
  };
}

/**
 * Measure `el` and `anchor`, then write `left`/`top` (for `position: fixed`)
 * and `data-placement` on `el`.
 */
export function placeFloating(
  el: HTMLElement,
  anchor: HTMLElement | RectLike,
  options: FloatingOptions = {},
): FloatingPosition {
  el.style.left = '0px';
  el.style.top = '0px';
  const box = el.getBoundingClientRect();
  const anchorRect = 'getBoundingClientRect' in anchor ? anchor.getBoundingClientRect() : anchor;
  const position = computeFloatingPosition(
    anchorRect,
    { width: box.width, height: box.height },
    { width: window.innerWidth, height: window.innerHeight },
    options,
  );
  el.style.left = `${position.left}px`;
  el.style.top = `${position.top}px`;
  el.dataset.placement = position.placement;
  return position;
}
