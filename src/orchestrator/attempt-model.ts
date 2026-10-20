import { el } from './dom';

/** Read only this attempt's recorded binding, never the board's current model. */
export function latestAttemptModel(events: readonly Record<string, unknown>[]) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type !== 'model_selected') continue;
    if (typeof event.providerId !== 'string' || !event.providerId.trim()
      || typeof event.modelId !== 'string' || !event.modelId.trim()) continue;
    return {
      providerId: event.providerId,
      modelId: event.modelId,
      routerId: typeof event.routerId === 'string' && event.routerId ? event.routerId : null,
    };
  }
  return null;
}

export function renderAttemptModel(events: readonly Record<string, unknown>[]): HTMLElement {
  const model = latestAttemptModel(events);
  const row = el('div', 'ov2-attempt-model');
  row.dataset.modelKey = JSON.stringify(model);
  row.append(el('span', 'ov2-attempt-model__label', 'Model'));
  const pending = model?.providerId === 'minnow-router';
  const ended = events.some((event) => event.type === 'attempt_end');
  const label = !model ? 'Not recorded'
    : pending ? (ended ? 'No routed model recorded' : 'Awaiting pool routing')
    : `${model.providerId} / ${model.modelId}`;
  row.append(el('span', 'ov2-attempt-model__value', label));
  const pool = pending ? model!.modelId : model?.routerId;
  if (pool) row.append(el('span', 'ov2-attempt-model__pool', `Pool: ${pool}`));
  return row;
}
