/** Jobs capture their own binding, otherwise the globally remembered chat selection. */
import { readRememberedModel } from '../config/model-selection.js';

export async function resolveJobRunModel(storedJob) {
  if (storedJob.modelId?.trim()) return { providerId: storedJob.providerId?.trim() || undefined, modelId: storedJob.modelId.trim() };
  const saved = await readRememberedModel();
  const value = typeof saved?.value === 'string' ? saved.value.trim() : '';
  const split = value.indexOf('\u001f');
  return split > 0
    ? { providerId: value.slice(0, split), modelId: value.slice(split + 1) }
    : { providerId: undefined, modelId: value || undefined };
}
