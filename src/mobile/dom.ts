/** Small DOM helpers for the phone app's hand-built screens. */

type Child = Node | string | null | undefined | false;

export interface ElProps {
  className?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  dataset?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
}

/** Create an element with classes, attributes, listeners and children. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props?.className) node.className = props.className;
  if (props?.text != null) node.textContent = props.text;
  for (const [name, value] of Object.entries(props?.attrs ?? {})) {
    if (value === false || value == null) continue;
    node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const [name, value] of Object.entries(props?.dataset ?? {})) node.dataset[name] = value;
  for (const [type, handler] of Object.entries(props?.on ?? {})) {
    node.addEventListener(type, handler as EventListener);
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
}

/** Uicons glyph (`fi-rr-*` / `fi-sr-*`), sized through `--mn-icon-size`. */
export function icon(glyph: string, size?: number): HTMLElement {
  const node = document.createElement('i');
  node.className = `fi ${glyph} icon-svg`;
  node.setAttribute('aria-hidden', 'true');
  if (size != null) node.style.setProperty('--mn-icon-size', `${size}px`);
  return node;
}

/** Icon-only button with an accessible name. */
export function iconButton(
  glyph: string,
  label: string,
  onClick: (event: MouseEvent) => void,
  className = '',
): HTMLButtonElement {
  return el(
    'button',
    {
      className: `m-icon-btn ${className}`.trim(),
      attrs: { type: 'button', 'aria-label': label, title: label },
      on: { click: onClick },
    },
    icon(glyph, 20),
  );
}

/** Centered placeholder for empty lists, errors and loading. */
export function emptyState(options: {
  glyph: string;
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
}): HTMLElement {
  return el(
    'div',
    { className: 'm-empty', attrs: { role: 'status' } },
    el('span', { className: 'm-empty__icon' }, icon(options.glyph, 26)),
    el('p', { className: 'm-empty__title', text: options.title }),
    options.body ? el('p', { className: 'm-empty__body', text: options.body }) : null,
    options.action
      ? el('button', {
          className: 'm-btn m-btn--primary',
          text: options.action.label,
          attrs: { type: 'button' },
          on: { click: options.action.onClick },
        })
      : null,
  );
}

/** "2m", "3h", "Yesterday", "12 Mar": compact list timestamps. */
export function shortTime(ts: number | undefined, now = Date.now()): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const delta = Math.max(0, now - ts);
  const minute = 60_000;
  if (delta < minute) return 'now';
  if (delta < 60 * minute) return `${Math.floor(delta / minute)}m`;
  if (delta < 24 * 60 * minute) return `${Math.floor(delta / (60 * minute))}h`;
  const date = new Date(ts);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (delta < 7 * 24 * 60 * minute) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Light haptic tick where the platform offers one. */
export function haptic(): void {
  try {
    navigator.vibrate?.(8);
  } catch {}
}
