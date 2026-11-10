type Placement = 'above' | 'below';

/** Fit a model picker around its trigger in the currently visible viewport. */
export function positionAnchoredModelPicker(
  panel: HTMLElement,
  anchor: HTMLElement,
  preferred: Placement,
  gap: number,
  width?: number,
): void {
  const viewport = window.visualViewport;
  const leftEdge = viewport?.offsetLeft ?? 0;
  const topEdge = viewport?.offsetTop ?? 0;
  const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth);
  const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight);
  const margin = 8;
  const box = anchor.getBoundingClientRect();
  const horizontalRoom = Math.max(0, rightEdge - leftEdge - 2 * margin);
  panel.style.maxWidth = `${horizontalRoom}px`;
  if (width !== undefined) panel.style.width = `${Math.min(width, horizontalRoom)}px`;
  const panelWidth = panel.offsetWidth || panel.getBoundingClientRect().width;
  const left = Math.max(leftEdge + margin, Math.min(box.right - panelWidth, rightEdge - panelWidth - margin));
  panel.style.left = `${left}px`;
  panel.style.right = 'auto';

  const above = Math.max(0, Math.min(box.top - gap, bottomEdge - margin) - topEdge - margin);
  const below = Math.max(0, bottomEdge - margin - Math.max(box.bottom + gap, topEdge + margin));
  const available = { above, below };
  const current = panel.dataset.placement as Placement | undefined;
  const wanted = Math.min(240, panel.offsetHeight || 240);
  const first = current ?? preferred;
  const other = first === 'above' ? 'below' : 'above';
  const side = available[first] < wanted && available[other] > available[first] ? other : first;
  const height = available[side];
  panel.dataset.placement = side;
  panel.toggleAttribute('data-model-menu-constrained', height < 320);
  panel.style.maxHeight = `${height}px`;
  panel.style.top = side === 'below' ? `${Math.max(topEdge + margin, box.bottom + gap)}px` : 'auto';
  panel.style.bottom = side === 'above' ? `${window.innerHeight - Math.min(bottomEdge - margin, box.top - gap)}px` : 'auto';
}
