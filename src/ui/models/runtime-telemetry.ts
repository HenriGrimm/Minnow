import type { ServeActivity } from '../../models/api-client';
import { overlayMatchesActivity, type InFlightPromptOverlay } from '../../models/in-flight-prompt';
import { localModelPhase, type LocalModelPhase } from '../../models/local-model-phase';
import { el, formatCount } from './dom';

const TRACE_SLOTS = 48;
const SVG_NS = 'http://www.w3.org/2000/svg';

export interface RuntimeNow {
  phase: LocalModelPhase['phase'];
  label: string;
  /** Current phase rate in tokens per second; null when idle or unknown. */
  rate: number | null;
  /** Work done in this phase, e.g. `2.6K tokens` or `18.4K of 46.1K`. */
  detail: string | null;
  progress: number | null;
}

export interface RuntimeFigure {
  label: string;
  value: string;
}

const positiveRate = (value: number | null | undefined): number | null =>
  value != null && Number.isFinite(value) && value > 0 ? value : null;

/** `44.8 tok/s`; whole numbers from 100 up, where a decimal is noise (`1,240 tok/s`). */
const tokS = (value: number | null | undefined): string | null => {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return value >= 100 ? `${Math.round(value).toLocaleString('en-US')} tok/s` : `${value.toFixed(1)} tok/s`;
};

/** What the serve is doing right now, in words. */
export function runtimeNow(activity: ServeActivity | undefined, overlay: InFlightPromptOverlay | null = null): RuntimeNow {
  if (!activity) return { phase: 'idle', label: 'Ready', rate: null, detail: null, progress: null };
  const { phase, rate, progress } = localModelPhase(activity, overlay);
  if (phase === 'idle') {
    return { phase, label: activity.stale ? 'No response from server' : 'Ready', rate: null, detail: null, progress: null };
  }
  const live = activity.mtplx?.live;
  if (phase === 'prompt') {
    const percent = progress == null ? null : Math.min(99, Math.floor(progress * 100));
    let detail: string | null = null;
    if (live?.promptDone != null && live.promptTotal) detail = `${formatCount(live.promptDone)} of ${formatCount(live.promptTotal)}`;
    else if (overlay && overlayMatchesActivity(activity, overlay) && overlay.total > 0) detail = `${formatCount(overlay.processed)} of ${formatCount(overlay.total)}`;
    else {
      const processed = activity.slots.find((slot) => slot.state === 'prompt')?.promptProcessed;
      if (processed) detail = `${formatCount(processed)} tokens`;
    }
    return { phase, label: percent == null ? 'Reading prompt' : `Reading prompt ${percent}%`, rate: positiveRate(rate), detail, progress };
  }
  const decoded = live?.completionTokens
    ?? activity.slots.filter((slot) => slot.state === 'generating').reduce((sum, slot) => sum + slot.decoded, 0);
  return { phase, label: 'Generating', rate: positiveRate(rate), detail: decoded ? `${formatCount(decoded)} tokens` : null, progress: null };
}

/**
 * Figures under the live line. MTPLX reports the last completed request;
 * llama.cpp `/slots` only knows the slots, so it shows their occupancy.
 */
export function runtimeFigures(activity: ServeActivity | undefined): { caption: string; figures: RuntimeFigure[] } | null {
  if (!activity?.available) return null;
  const latest = activity.mtplx?.latest as (NonNullable<ServeActivity['mtplx']>['latest'] & { prompt_tokens?: number }) | null | undefined;
  if (activity.mtplx) {
    if (!latest) return null;
    const figures: RuntimeFigure[] = [
      { label: 'Generation', value: tokS(latest.decode_tok_s) ?? '—' },
      { label: 'Prompt', value: tokS(latest.prefill_tok_s) ?? '—' },
      { label: 'First token', value: latest.ttft_s != null && Number.isFinite(latest.ttft_s) ? `${latest.ttft_s.toFixed(2)} s` : '—' },
    ];
    if (latest.cached_tokens != null && latest.prompt_tokens) {
      figures.push({ label: 'From cache', value: `${formatCount(latest.cached_tokens)} of ${formatCount(latest.prompt_tokens)}` });
    } else if (latest.cached_tokens != null) {
      figures.push({ label: 'From cache', value: formatCount(latest.cached_tokens) });
    }
    return { caption: 'Last request', figures };
  }
  if (!activity.slots.length) return null;
  const busy = activity.slots.filter((slot) => slot.state !== 'idle').length;
  return {
    caption: 'Slots',
    figures: [
      { label: 'Busy', value: `${busy} of ${activity.slots.length}` },
      ...(activity.queued > 0 ? [{ label: 'Queued', value: String(activity.queued) }] : []),
    ],
  };
}

export function createRuntimeTelemetry(): {
  element: HTMLElement;
  update: (activity: ServeActivity | undefined, overlay?: InFlightPromptOverlay | null) => void;
} {
  const element = el('div', 'models-runtime-telemetry');

  const now = el('div', 'models-runtime-telemetry__now');
  const label = el('span', 'models-runtime-telemetry__label');
  const rate = el('span', 'models-runtime-telemetry__rate');
  const detail = el('span', 'models-runtime-telemetry__detail');
  now.append(label, rate, detail);

  const meter = el('div', 'models-runtime-telemetry__meter');
  const trace = document.createElementNS(SVG_NS, 'svg');
  trace.classList.add('models-runtime-telemetry__trace');
  trace.setAttribute('viewBox', `0 0 ${TRACE_SLOTS - 1} 40`);
  trace.setAttribute('preserveAspectRatio', 'none');
  trace.setAttribute('aria-hidden', 'true');
  const area = document.createElementNS(SVG_NS, 'path');
  area.classList.add('models-runtime-telemetry__area');
  const line = document.createElementNS(SVG_NS, 'path');
  line.classList.add('models-runtime-telemetry__line');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  trace.append(area, line);
  const progress = el('div', 'models-runtime-telemetry__progress');
  progress.setAttribute('aria-hidden', 'true');
  meter.append(trace, progress);

  const last = el('div', 'models-runtime-telemetry__last');
  const caption = el('span', 'models-runtime-telemetry__caption');
  const figures = el('dl', 'models-runtime-telemetry__figures');
  last.append(caption, figures);

  element.append(now, meter, last);

  const history: number[] = [];
  let lastSample: number | undefined;
  let shownPhase: LocalModelPhase['phase'] = 'idle';
  let heldRate: number | null = null;

  const paintTrace = (): void => {
    const peak = Math.max(1, ...history) * 1.25;
    const start = history.length > 1 ? TRACE_SLOTS - history.length : 0;
    const values = history.length > 1 ? history : [history[0] ?? 0, history[0] ?? 0];
    const step = history.length > 1 ? 1 : TRACE_SLOTS - 1;
    const d = values.map((value, index) =>
      `${index ? 'L' : 'M'}${start + index * step} ${(39 - value / peak * 34).toFixed(2)}`).join('');
    line.setAttribute('d', d);
    area.setAttribute('d', `${d}V40H${start}Z`);
  };
  paintTrace();

  const setText = (node: HTMLElement, text: string): void => {
    if (node.textContent !== text) node.textContent = text;
  };

  return {
    element,
    update(activity, overlay = null) {
      const state = runtimeNow(activity, overlay);
      // Hold the last rate within a phase so a sample without one doesn't blank the figure.
      if (state.phase !== shownPhase) heldRate = null;
      shownPhase = state.phase;
      if (state.rate != null) heldRate = state.rate;
      element.dataset.phase = state.phase;
      setText(label, state.label);
      setText(rate, tokS(heldRate) ?? '');
      setText(detail, state.detail ?? '');
      rate.hidden = heldRate == null;
      detail.hidden = !state.detail;
      if (state.progress != null) {
        element.dataset.progress = '';
        progress.style.setProperty('--models-runtime-progress', String(state.progress));
      } else {
        delete element.dataset.progress;
      }

      const figureSet = runtimeFigures(activity);
      last.hidden = !figureSet;
      if (figureSet) {
        setText(caption, figureSet.caption);
        const rows = figureSet.figures;
        while (figures.children.length > rows.length) figures.lastElementChild!.remove();
        rows.forEach((figure, index) => {
          let row = figures.children[index] as HTMLElement | undefined;
          if (!row) {
            row = el('div');
            row.append(el('dt'), el('dd'));
            figures.append(row);
          }
          setText(row.firstElementChild as HTMLElement, figure.label);
          setText(row.lastElementChild as HTMLElement, figure.value);
        });
      }

      if (!activity || activity.updatedAt === lastSample) return;
      lastSample = activity.updatedAt;
      // The trace plots generation speed; prompt rates run far higher and would flatten it.
      if (state.phase === 'idle') history.push(0);
      else if (state.phase === 'generating' && heldRate != null) history.push(heldRate);
      if (history.length > TRACE_SLOTS) history.shift();
      if (history.every((value) => value === 0)) history.length = 0;
      paintTrace();
    },
  };
}
