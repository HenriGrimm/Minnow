/** Small DOM helpers shared by the Super Plan surface. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 16px-grid stroke icon, drawn in currentColor. */
export function svg(paths: string, size = 14): SVGSVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 16 16');
  node.setAttribute('width', String(size));
  node.setAttribute('height', String(size));
  node.setAttribute('fill', 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', '1.5');
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');
  node.setAttribute('aria-hidden', 'true');
  node.innerHTML = paths;
  return node;
}

export const ICON = {
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  send: '<path d="M8 13V3.5M4 7l4-3.5L12 7"/>',
  chevronLeft: '<path d="M9.5 4 6 8l3.5 4"/>',
  chevronRight: '<path d="M6.5 4 10 8l-3.5 4"/>',
  check: '<path d="m3.5 8.5 3 3 6-7"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
  play: '<path d="M5 3.5v9l7-4.5z"/>',
  more: '<circle cx="3.5" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.5" cy="8" r=".6"/>',
  retry: '<path d="M12.5 5.5A5 5 0 1 0 13 9"/><path d="M13 2.5v3h-3"/>',
  file: '<path d="M4.5 2h5l2.5 2.5V14h-7.5z"/><path d="M9.5 2v2.5H12"/>',
  arrowUpRight: '<path d="M5 11 11 5M6 5h5v5"/>',
} as const;

export interface ButtonOptions {
  variant?: 'primary' | 'danger' | 'quiet';
  disabled?: boolean;
  title?: string;
  icon?: string;
}

/** A `.sp-btn`. The handler may be async; the button stays disabled until it settles. */
export function button(label: string, onClick: () => unknown | Promise<unknown>, options: ButtonOptions = {}): HTMLButtonElement {
  const node = el('button', `sp-btn${options.variant ? ` sp-btn--${options.variant}` : ''}`);
  node.type = 'button';
  if (options.icon) node.append(svg(options.icon));
  node.append(document.createTextNode(label));
  if (options.title) node.title = options.title;
  node.disabled = Boolean(options.disabled);
  node.addEventListener('click', () => {
    if (node.disabled) return;
    const result = onClick();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      node.disabled = true;
      node.setAttribute('aria-busy', 'true');
      void (result as Promise<unknown>).finally(() => {
        if (!node.isConnected) return;
        node.disabled = Boolean(options.disabled);
        node.removeAttribute('aria-busy');
      });
    }
  });
  return node;
}

/** 3:07, 1:02:07 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}:${String(seconds).padStart(2, '0')}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** 14:32 in the viewer's locale-neutral 24h form, for feed rows. */
export function formatTimeOfDay(atMs: number): string {
  const date = new Date(atMs);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Last path segment. */
export function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Report a failed action where the user is looking. */
export async function reportActionError(err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const { setStatus } = await import('../status');
  setStatus('err', message || 'Super Plan action failed');
}
