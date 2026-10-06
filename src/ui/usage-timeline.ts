import type { TokenLedgerEntry } from '../usage/types';
import { buildUsageTimeline, usageAxisMaximum, type UsageBucket, type UsageInterval } from '../usage/usage-timeline';

const SVG_NS = 'http://www.w3.org/2000/svg';
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function dateLabel(at: number, interval: UsageInterval, detail = false): string {
  return new Date(at).toLocaleString(undefined, {
    ...(interval !== 'year' ? { month: 'short' as const } : {}),
    ...(!['month', 'year'].includes(interval) ? { day: 'numeric' as const } : {}),
    ...(detail || ['month', 'year'].includes(interval) ? { year: 'numeric' as const } : {}),
    ...(interval === 'hour' ? { hour: 'numeric' as const, minute: '2-digit' as const } : {}),
  });
}

export function createUsageTimeline(entries: TokenLedgerEntry[]): HTMLElement {
  const chart = document.createElement('figure');
  chart.className = 'usage-chart';
  chart.innerHTML = `<figcaption class="usage-chart__header">
    <span class="usage-subsection__title">Token usage over time</span>
    <label class="usage-chart__range">Chart range <select class="usage-scope" aria-label="Chart time range">
      <option value="0">All retained</option><option value="30">Last 30 days</option><option value="7">Last 7 days</option>
    </select></label>
  </figcaption><p class="usage-note usage-chart__note"></p><div class="usage-chart__body"></div>`;
  const range = chart.querySelector('select')!;
  const note = chart.querySelector('.usage-chart__note')!;
  const body = chart.querySelector('.usage-chart__body')!;
  const render = () => {
    body.replaceChildren();
    const { buckets, interval } = buildUsageTimeline(entries, Number(range.value));
    const count = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
    note.textContent = `Tokens per ${interval} · ${count.toLocaleString()} retained completions. Older completions remain in overall totals.`;
    if (!buckets.length) {
      const empty = document.createElement('p');
      empty.className = 'usage-empty';
      empty.textContent = 'No retained completions in this time range.';
      body.appendChild(empty);
      return;
    }
    const plot = document.createElement('div');
    plot.className = 'usage-chart__plot';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('height', interval === 'hour' ? '256' : '240');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', `Token usage over time, ${count} retained completions, ${buckets.reduce((sum, b) => sum + b.tokens, 0).toLocaleString()} tokens. Use arrow keys to explore intervals.`);
    const add = (tag: string, attrs: Record<string, string>, text?: string, parent: Element = svg) => {
      const node = document.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      if (text !== undefined) node.textContent = text;
      parent.appendChild(node);
      return node;
    };
    const maximum = usageAxisMaximum(Math.max(...buckets.map(bucket => bucket.tokens)));
    const y = (tokens: number) => 202 - tokens / maximum * 186;
    for (let tick = 0; tick <= 4; tick++) {
      const value = maximum * tick / 4;
      add('line', { x1: '0', x2: '100%', y1: String(y(value)), y2: String(y(value)), class: 'usage-chart__grid' });
      add('text', { x: '-12', y: String(y(value) + 4), 'text-anchor': 'end' }, compact.format(value));
    }
    const detail = document.createElement('div');
    detail.className = 'usage-chart__detail';
    detail.setAttribute('aria-live', 'polite');
    const bars: Element[] = [];
    let active = buckets.length - 1;
    const describe = (bucket: UsageBucket) => {
      const date = dateLabel(bucket.at, interval, true);
      return interval === 'week' ? `${date} – ${dateLabel(bucket.end - 1, 'day', true)}` : date;
    };
    const select = (index: number) => {
      active = index;
      bars.forEach((bar, i) => {
        bar.classList.toggle('is-active', i === index);
        bar.setAttribute('tabindex', i === index ? '0' : '-1');
      });
      const bucket = buckets[index]!;
      detail.replaceChildren();
      const date = document.createElement('span');
      date.className = 'usage-chart__date';
      date.textContent = describe(bucket);
      const total = document.createElement('strong');
      total.textContent = `${bucket.tokens.toLocaleString()} tokens`;
      const split = document.createElement('span');
      split.textContent = `${bucket.prompt.toLocaleString()} prompt · ${bucket.completion.toLocaleString()} completion · ${bucket.count.toLocaleString()} ${bucket.count === 1 ? 'response' : 'responses'}`;
      detail.append(date, total, split);
    };
    const slot = 100 / buckets.length;
    const width = Math.min(3.5, slot * 0.72);
    for (const [index, bucket] of buckets.entries()) {
      const label = `${describe(bucket)}: ${bucket.tokens.toLocaleString()} tokens, ${bucket.count.toLocaleString()} ${bucket.count === 1 ? 'response' : 'responses'}`;
      const group = add('g', { class: 'usage-chart__bucket', role: 'img', 'aria-label': label, tabindex: '-1' });
      add('title', {}, label, group);
      add('rect', { x: `${slot * index}%`, y: '8', width: `${slot}%`, height: '198', class: 'usage-chart__hit' }, undefined, group);
      add('rect', { x: `${slot * (index + 0.5) - width / 2}%`, y: String(y(bucket.tokens)), width: `${width}%`, height: String(202 - y(bucket.tokens)), rx: '2', class: 'usage-chart__bar' }, undefined, group);
      group.addEventListener('pointerenter', () => select(index));
      group.addEventListener('click', () => select(index));
      group.addEventListener('focus', () => select(index));
      group.addEventListener('keydown', event => {
        const key = (event as KeyboardEvent).key;
        const target = key === 'ArrowLeft' ? Math.max(0, active - 1) : key === 'ArrowRight' ? Math.min(buckets.length - 1, active + 1) : key === 'Home' ? 0 : key === 'End' ? buckets.length - 1 : null;
        if (target === null) return;
        event.preventDefault();
        select(target);
        (bars[target] as SVGElement).focus();
      });
      bars.push(group);
    }
    const tickCount = Math.min(5, buckets.length);
    const ticks = Array.from({ length: tickCount }, (_, i) => Math.round(i * (buckets.length - 1) / Math.max(1, tickCount - 1)));
    ticks.forEach((index, i) => {
      const x = buckets.length === 1 ? '50%' : `${i / (ticks.length - 1) * 100}%`;
      const at = buckets[index]!.at;
      const label = add('text', { x, y: '230', 'text-anchor': buckets.length === 1 ? 'middle' : i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle', class: i % 2 ? 'usage-chart__tick--minor' : '' }, dateLabel(at, interval === 'hour' ? 'day' : interval));
      if (interval === 'hour') {
        add('tspan', { x, dy: '16' }, new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }), label);
      }
    });
    select(active);
    plot.appendChild(svg);
    const hint = document.createElement('p');
    hint.className = 'usage-chart__hint';
    hint.textContent = 'Hover or focus the chart to inspect. Use ← → to move between intervals.';
    body.append(plot, detail, hint);
  };
  range.addEventListener('change', render);
  render();
  return chart;
}
