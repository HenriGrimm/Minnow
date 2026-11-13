import type { ServeActivity } from '../../models/api-client';
import { el, formatCount } from './dom';

const MAX_RATE_SAMPLES = 40;

export interface RuntimeTelemetrySample {
  speed: number | null;
  promptTokens: number | null;
  decodedTokens: number | null;
  slotsBusy: number | null;
  slotCount: number | null;
}

export function runtimeTelemetrySample(activity: ServeActivity | undefined): RuntimeTelemetrySample {
  const absent = { speed: null, promptTokens: null, decodedTokens: null, slotsBusy: null, slotCount: null };
  if (!activity?.available || activity.stale) return absent;
  const { slots } = activity;
  const running = slots.filter((slot) => slot.state !== 'idle');
  const rates = running.map((slot) => slot.tokensPerSecond).filter((rate): rate is number => rate != null && Number.isFinite(rate));
  const decodeRate = activity.mtplx?.latest?.decode_tok_s;
  const speed = decodeRate != null && Number.isFinite(decodeRate)
    ? decodeRate : rates.length ? rates.reduce((sum, rate) => sum + rate, 0) : slots.length && !running.length ? 0 : null;
  return {
    speed,
    promptTokens: slots.length ? running.reduce((sum, slot) => sum + slot.promptProcessed, 0) : null,
    decodedTokens: slots.length ? running.reduce((sum, slot) => sum + slot.decoded, 0) : null,
    slotsBusy: activity.mtplx?.activeRequests ?? (slots.length ? running.length : null),
    slotCount: slots.length || null,
  };
}

export function createRuntimeTelemetry(): { element: HTMLElement; update: (activity: ServeActivity | undefined) => void } {
  const element = el('div', 'models-runtime-telemetry');
  const figures = el('dl', 'models-runtime-telemetry__figures');
  const entries = ['Speed', 'Prompt', 'Decoded', 'Slots busy'].map((label) => {
    const row = el('div');
    const value = el('dd');
    row.append(el('dt', undefined, label), value);
    figures.append(row);
    return value;
  });
  const spark = el('div', 'models-runtime-telemetry__spark');
  spark.setAttribute('aria-hidden', 'true');
  const history: number[] = [];
  let lastSample: number | undefined;
  element.append(figures, spark);
  return {
    element,
    update(activity) {
      const { speed, promptTokens, decodedTokens, slotsBusy, slotCount } = runtimeTelemetrySample(activity);
      const count = (value: number | null) => value == null ? '—' : formatCount(value);
      const metric = [speed == null ? '—' : `${speed.toFixed(1)} tok/s`, count(promptTokens), count(decodedTokens), slotsBusy == null ? '—' : slotCount ? `${slotsBusy} / ${slotCount}` : String(slotsBusy)];
      metric.forEach((value, index) => { if (entries[index].textContent !== value) entries[index].textContent = value; });
      if (!activity || speed == null || activity.updatedAt === lastSample) return;
      lastSample = activity.updatedAt;
      history.push(Math.max(0, speed));
      if (history.length > MAX_RATE_SAMPLES) history.shift();
      const peak = Math.max(1, ...history);
      spark.replaceChildren(...history.map((rate) => {
        const bar = el('span');
        bar.style.setProperty('--rate-fill', String(rate / peak));
        return bar;
      }));
    },
  };
}
