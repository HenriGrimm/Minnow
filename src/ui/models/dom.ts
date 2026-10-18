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

/** Icon glyph element (Flaticon uicons). */
export function icon(name: string, className = ''): HTMLElement {
  const node = document.createElement('i');
  node.className = `fi fi-rr-${name} icon-svg${className ? ` ${className}` : ''}`;
  node.setAttribute('aria-hidden', 'true');
  return node;
}

/** Icon-only button with an accessible name. */
export function iconButton(
  glyph: string,
  label: string,
  onClick: () => void,
  className = '',
): HTMLButtonElement {
  const btn = el('button', `models-icon-btn${className ? ` ${className}` : ''}`);
  btn.type = 'button';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.appendChild(icon(glyph));
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return btn;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Compact token counts: 262144 -> 256K. */
export function formatContext(tokens: number | null | undefined): string {
  if (!tokens || !Number.isFinite(tokens)) return '—';
  if (tokens >= 1024 * 1024) return `${Math.round(tokens / (1024 * 1024))}M`;
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}K`;
  return String(tokens);
}

export function formatParams(paramsB: number | null | undefined): string {
  if (!paramsB || !Number.isFinite(paramsB)) return '—';
  return paramsB >= 1 ? `${Number(paramsB.toFixed(1))}B` : `${Math.round(paramsB * 1000)}M`;
}

/** Compact counts for Hub stats: 1240000 -> 1.2M. */
export function formatCount(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return String(Math.round(value));
}

/** Elapsed seconds since a timestamp, as `1m 04s`. */
export function formatElapsed(sinceMs: number): string {
  const total = Math.max(0, Math.round((Date.now() - sinceMs) / 1000));
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  return `${mins}m ${String(total % 60).padStart(2, '0')}s`;
}

export async function copyText(value: string, trigger?: HTMLElement): Promise<boolean> {
  let ok = false;
  try {
    await navigator.clipboard.writeText(value);
    ok = true;
  } catch {
    try {
      const scratch = document.createElement('textarea');
      scratch.value = value;
      scratch.setAttribute('aria-hidden', 'true');
      scratch.style.position = 'fixed';
      scratch.style.opacity = '0';
      document.body.appendChild(scratch);
      scratch.select();
      ok = document.execCommand('copy');
      scratch.remove();
    } catch {
      ok = false;
    }
  }
  if (ok && trigger) {
    trigger.classList.add('is-copied');
    window.setTimeout(() => trigger.classList.remove('is-copied'), 1200);
  }
  return ok;
}

/** Monospace value with a trailing copy affordance. */
export function copyField(value: string, ariaLabel: string): HTMLElement {
  const wrap = el('div', 'models-copy-field');
  const text = el('span', 'models-copy-field__value', value);
  text.title = value;
  const btn = iconButton('copy', ariaLabel, () => void copyText(value, btn), '');
  wrap.append(text, btn);
  return wrap;
}

/** Uppercase caption used above every workbench block. */
export function sectionLabel(text: string): HTMLElement {
  return el('h3', 'models-block__label', text);
}

/** Small pill used for quant, format, arch, and status words. */
export function chip(text: string, variant?: string): HTMLElement {
  return el('span', `models-chip${variant ? ` models-chip--${variant}` : ''}`, text);
}

/** Empty state: a headline, one sentence, and an optional action. */
export function emptyState(options: {
  glyph: string;
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}): HTMLElement {
  const wrap = el('div', 'models-empty');
  const glyph = icon(options.glyph, 'models-empty__glyph');
  wrap.append(glyph, el('p', 'models-empty__title', options.title), el('p', 'models-empty__body', options.body));
  if (options.action) {
    const btn = el('button', 'models-btn models-btn--primary', options.action.label);
    btn.type = 'button';
    btn.addEventListener('click', options.action.onClick);
    wrap.appendChild(btn);
  }
  return wrap;
}

/** Rows of skeleton bars shown while a scan is in flight. */
export function skeletonRows(count: number): HTMLElement {
  const wrap = el('div', 'models-skeleton');
  for (let i = 0; i < count; i += 1) {
    wrap.appendChild(el('div', 'models-skeleton__row'));
  }
  return wrap;
}

export function textButton(
  label: string,
  onClick: () => void,
  variant?: 'primary' | 'danger',
): HTMLButtonElement {
  const btn = el('button', `models-btn${variant ? ` models-btn--${variant}` : ''}`, label);
  btn.type = 'button';
  btn.addEventListener('click', onClick);
  return btn;
}

/** Local, reversible feedback for an asynchronous control action. */
export async function withButtonBusy(
  button: HTMLButtonElement,
  label: string,
  action: () => Promise<void>,
): Promise<void> {
  if (button.disabled || button.getAttribute('aria-busy') === 'true') return;
  const children = [...button.childNodes];
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = label;
  const spinner = document.createElement('span');
  spinner.className = 'mn-action-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  button.prepend(spinner);
  try {
    await action();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.replaceChildren(...children);
  }
}

/** True when the models catalog/library search field has focus (call before replacing DOM). */
export function isModelsSearchInputFocused(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLInputElement && active.classList.contains('models-search__input');
}

/** Restore focus and caret after a full toolbar re-render. */
export function restoreModelsSearchInputFocus(host: ParentNode): void {
  const input = host.querySelector<HTMLInputElement>('.models-search__input');
  if (!input) return;
  input.focus();
  const end = input.value.length;
  input.setSelectionRange(end, end);
}
