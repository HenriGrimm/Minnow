import { el } from './dom';
import { getRouterConfigSync } from '../models/routers';

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
      ...(typeof event.routerName === 'string' && event.routerName.trim() ? { routerName: event.routerName } : {}),
      ...(typeof event.reasoning === 'string' && event.reasoning ? { reasoning: event.reasoning } : {}),
      ...(typeof event.reasoningStatus === 'string' ? { reasoningStatus: event.reasoningStatus } : {}),
    };
  }
  return null;
}

export function renderAttemptModel(events: readonly Record<string, unknown>[]): HTMLElement {
  const model = latestAttemptModel(events);
  const row = el('div', 'ov2-attempt-model');
  row.append(el('span', 'ov2-attempt-model__label', 'Model'));
  const pending = model?.providerId === 'minnow-router';
  const ended = events.some((event) => event.type === 'attempt_end');
  const label = !model ? 'Not recorded'
    : pending ? (ended ? 'No routed model recorded' : 'Awaiting pool routing')
    : `${model.providerId} / ${model.modelId}`;
  row.append(el('span', 'ov2-attempt-model__value', label));
  const pool = pending ? model!.modelId : model?.routerId;
  const poolName = pool ? getRouterConfigSync().routers.find((router) => router.id === pool)?.name || model?.routerName || 'Unavailable pool' : null;
  row.dataset.modelKey = JSON.stringify({ model, poolName, ended });
  if (poolName) row.append(el('span', 'ov2-attempt-model__pool', `Pool: ${poolName}`));
  if (model && !pending) {
    const reasoning = model.reasoningStatus === 'unsupported' ? 'Unsupported'
      : model.reasoning || 'Not recorded';
    row.append(el('span', 'ov2-attempt-model__pool', `Reasoning: ${reasoning}`));
  }
  return row;
}
