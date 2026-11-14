/**
 * Small DOM helpers shared by the Automations views.
 */

import { createIcon, type IconName } from '../icon';
import { setActivityShimmerText } from '../activity-shimmer';
import type { AutomationRunSummary, SchedulerRunStatus } from '../../scheduler/client';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function icon(name: string, size = 15, className?: string): HTMLElement {
  return createIcon(name as IconName, { size, className });
}

export function button(label: string, options: { variant?: 'primary' | 'ghost' | 'danger' | 'default'; icon?: string; small?: boolean; title?: string } = {}): HTMLButtonElement {
  const node = el('button', `auto-btn auto-btn--${options.variant ?? 'default'}${options.small ? ' auto-btn--sm' : ''}`);
  node.type = 'button';
  if (options.icon) node.append(icon(options.icon, options.small ? 13 : 14));
  if (label) node.append(el('span', undefined, label));
  if (options.title) node.title = options.title;
  if (!label && options.title) node.setAttribute('aria-label', options.title);
  return node;
}

/** A switch with a real button and pressed state. */
export function toggleSwitch(label: string, on: boolean, onChange: (next: boolean) => void): HTMLButtonElement {
  const node = el('button', 'auto-switch');
  node.type = 'button';
  node.setAttribute('role', 'switch');
  node.setAttribute('aria-label', label);
  const set = (value: boolean) => {
    node.setAttribute('aria-checked', String(value));
    node.classList.toggle('is-on', value);
  };
  set(on);
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    const next = node.getAttribute('aria-checked') !== 'true';
    set(next);
    onChange(next);
  });
  return node;
}

export function liveDot(tone: 'run' | 'ok' | 'fail' | 'warn' | 'idle' | 'skip' = 'run', small = false): HTMLElement {
  const dot = el('span', `auto-dot auto-dot--${tone}${small ? ' auto-dot--sm' : ''}`);
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}

/**
 * A line that is being worked on right now, painted with the same activity
 * ripple chats use while they think and call tools.
 */
export function streamingText<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text: string): HTMLElementTagNameMap[K] {
  const node = el(tag, `${className} auto-streaming`.trim());
  setActivityShimmerText(node, text);
  return node;
}

/** Update a streaming line in place; the ripple keeps running when the text is unchanged. */
export function setStreamingText(node: Element, text: string): void {
  setActivityShimmerText(node, text, '', { transition: true });
}

export function chip(text: string, className = ''): HTMLElement {
  return el('span', `auto-chip ${className}`.trim(), text);
}

/** "12:41" today, "Mon 9:00" this week, otherwise a short date. */
export function clockTime(iso?: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return time;
  const days = Math.abs(now.getTime() - date.getTime()) / 86_400_000;
  if (days < 6) return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "in 4m", "in 2h 10m", or a clock time further out. */
export function untilText(iso?: string | null, now = Date.now()): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 30_000) return 'now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 24 * 60) return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return clockTime(iso);
}

/** Elapsed "1m 48s" style. */
export function elapsedText(fromIso: string, toIso?: string | null, now = Date.now()): string {
  const end = toIso ? Date.parse(toIso) : now;
  const total = Math.max(0, Math.round((end - Date.parse(fromIso)) / 1000));
  if (!Number.isFinite(total)) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function runTone(run: Pick<AutomationRunSummary, 'status' | 'quiet'>): 'run' | 'ok' | 'fail' | 'skip' | 'idle' {
  if (run.status === 'running') return 'run';
  if (run.status === 'failed' || run.status === 'timeout') return 'fail';
  if (run.status === 'cancelled' || run.quiet) return 'skip';
  return 'ok';
}

export function statusWord(status: SchedulerRunStatus, quiet?: boolean): string {
  if (status === 'running') return 'Running';
  if (status === 'failed') return 'Failed';
  if (status === 'timeout') return 'Timed out';
  if (status === 'cancelled') return 'Stopped';
  return quiet ? 'Nothing to do' : 'Done';
}

/**
 * The last-runs strip, oldest left. Ticks whose run id was not seen before get
 * the landing animation; `seen` is updated in place.
 */
export function renderTicks(target: HTMLElement, runs: AutomationRunSummary[], seen: Set<string>, slots = 20): void {
  const ordered = [...runs].slice(0, slots).reverse();
  const firstPaint = seen.size === 0;
  const nodes: HTMLElement[] = [];
  for (let i = ordered.length; i < slots; i += 1) nodes.push(el('i', 'auto-tick auto-tick--empty'));
  for (const run of ordered) {
    const tone = runTone(run);
    const tick = el('i', `auto-tick auto-tick--${tone}`);
    tick.title = `${statusWord(run.status, run.quiet)} · ${clockTime(run.startedAt)}${run.headline ? ` · ${run.headline}` : ''}`;
    if (!firstPaint && !seen.has(run.id)) tick.classList.add('is-new');
    seen.add(run.id);
    nodes.push(tick);
  }
  target.replaceChildren(...nodes);
  target.setAttribute('aria-label', `Last ${ordered.length} runs: ${ordered.filter((r) => runTone(r) === 'fail').length} failed`);
}

export function workspaceBasename(absPath?: string | null): string {
  const normalized = String(absPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).at(-1) ?? '';
}

/** Shorten a home-relative path for display. */
export function displayPath(absPath?: string | null): string {
  const value = String(absPath ?? '');
  const home = value.match(/^([A-Za-z]:)?[\\/](Users|home)[\\/][^\\/]+/i)?.[0];
  return home ? `~${value.slice(home.length).replace(/\\/g, '/')}` : value.replace(/\\/g, '/');
}

/** Reveal an element with the shared enter motion once. */
export function enter(node: HTMLElement, delayMs = 0): HTMLElement {
  node.classList.add('auto-enter');
  if (delayMs) node.style.animationDelay = `${delayMs}ms`;
  node.addEventListener('animationend', () => {
    node.classList.remove('auto-enter');
    node.style.animationDelay = '';
  }, { once: true });
  return node;
}
