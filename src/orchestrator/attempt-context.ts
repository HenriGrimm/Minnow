import { el } from './dom';
import { createIcon } from '../ui/icon';
import { formatStatCount } from '../usage/format-stat-count';

export function latestAttemptContext(events: readonly Record<string, unknown>[]) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type !== 'context_usage') continue;
    if (typeof event.used !== 'number' || !Number.isFinite(event.used) || event.used < 0) continue;
    const limit = typeof event.limit === 'number' && Number.isFinite(event.limit) && event.limit > 0
      ? event.limit : null;
    return {
      used: event.used,
      limit,
      isEstimate: event.isEstimate !== false,
      percent: limit === null ? null : Math.round(event.used / limit * 100),
    };
  }
  return null;
}

export function renderAttemptContext(events: readonly Record<string, unknown>[]): HTMLDetailsElement {
  const context = latestAttemptContext(events);
  const details = document.createElement('details');
  details.className = 'ov2-context';
  details.dataset.contextKey = JSON.stringify(context);
  const summary = document.createElement('summary');
  const count = (n: number) => formatStatCount(n).display;
  const label = context
    ? `Context ${context.isEstimate ? '~' : ''}${count(context.used)} / ${context.limit === null ? '?' : count(context.limit)}${context.percent === null ? '' : ` tokens (${context.percent}%)`}`
    : 'Context unavailable';
  const wheel = el('span', 'ov2-context__wheel');
  wheel.setAttribute('aria-hidden', 'true');
  const percent = context?.percent ?? 0;
  wheel.style.setProperty('--context-fill', `${Math.max(0, Math.min(100, percent))}%`);
  details.classList.toggle('ov2-context--warn', percent >= 85);
  summary.append(wheel, document.createTextNode(label));
  summary.appendChild(createIcon('chevronRight', { size: 12, className: 'ov2-context__chevron' }));
  details.append(summary);
  const description = context
    ? `${context.percent === null ? 'Context limit unknown.' : `${context.percent}% used. ${count(Math.max(0, context.limit! - context.used))} tokens remaining.`} ${context.isEstimate ? 'Estimated tokens.' : 'Provider-reported tokens.'} Updated at model round boundaries; this is context occupancy, not cumulative usage.`
    : 'No context measurement recorded for this attempt. New agent runs record context at model round boundaries.';
  details.append(el('p', 'ov2-context__description', description));
  return details;
}
