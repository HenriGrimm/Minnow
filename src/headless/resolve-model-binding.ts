import { resolveWorkAgentBinding } from '../agents/resolve-work-agent-binding';
import { getUserWorkAgentOverride } from '../agents/work-agent-registry';
import type { WorkAgentDefinition } from '../agents/work-agent-types';
import { bindLibraryModel } from '../models/api-client';
import { isLibraryModelBinding } from '../models/model-select-library';
import { getActiveProvider, invalidateProviderCache } from '../providers/store';
import type { Chat } from '../types';
import type { HeadlessRunCliOptions } from './argv';

/** Explicit CLI selections win over agent defaults; synthetic providers never enter registry fallback. */
export async function resolveHeadlessModelBinding(chat: Chat, cli: HeadlessRunCliOptions, agent: WorkAgentDefinition | null, signal: AbortSignal) {
  signal.throwIfAborted();
  const defaultProviderId = cli.providerId ?? chat.providerId ?? (await getActiveProvider()).id;
  const userOverride = {
    ...(agent ? getUserWorkAgentOverride(agent.id) : undefined),
    ...(cli.providerId !== undefined ? { providerId: cli.providerId } : {}),
    ...(cli.modelId !== undefined ? { modelId: cli.modelId } : {}),
  };
  let binding = await resolveWorkAgentBinding(agent, chat, { providerId: defaultProviderId, modelId: cli.modelId ?? chat.modelId }, { userOverride });
  if (isLibraryModelBinding(binding.providerId, binding.modelId)) {
    binding = { ...binding, ...await bindLibraryModel(binding.providerId, binding.modelId, signal) };
    invalidateProviderCache();
  }
  signal.throwIfAborted();
  await getActiveProvider(binding.providerId, { strict: true });
  return binding;
}
