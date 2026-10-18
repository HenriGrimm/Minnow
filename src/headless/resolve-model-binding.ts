import { resolveWorkAgentBinding } from '../agents/resolve-work-agent-binding';
import type { WorkAgentDefinition } from '../agents/work-agent-types';
import { bindLibraryModel } from '../models/api-client';
import { isLibraryModelBinding } from '../models/model-select-library';
import { getActiveProvider, invalidateProviderCache } from '../providers/store';
import type { Chat } from '../types';
import type { HeadlessRunCliOptions } from './argv';

/** Explicit CLI selections win over agent defaults; synthetic providers never enter registry fallback. */
export async function resolveHeadlessModelBinding(chat: Chat, cli: HeadlessRunCliOptions, agent: WorkAgentDefinition | null, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!cli.modelId && !chat.modelId) {
    const response = await fetch('/api/config/default-model', { signal });
    if (!response.ok) throw new Error('Could not read the last selected chat model');
    const saved = await response.json() as { value?: string };
    const pair = saved.value?.split('\u001f');
    if (pair?.length === 2) { chat.providerId = pair[0]; chat.modelId = pair[1]; }
    else if (saved.value) chat.modelId = saved.value;
  }
  const defaultProviderId = cli.providerId ?? chat.providerId ?? (await getActiveProvider()).id;
  const selectedChat = { ...chat, providerId: cli.providerId ?? chat.providerId, modelId: cli.modelId ?? chat.modelId };
  let binding = await resolveWorkAgentBinding(agent, selectedChat, { providerId: defaultProviderId, modelId: selectedChat.modelId });
  if (isLibraryModelBinding(binding.providerId, binding.modelId)) {
    binding = { ...binding, ...await bindLibraryModel(binding.providerId, binding.modelId, signal) };
    invalidateProviderCache();
  }
  signal.throwIfAborted();
  await getActiveProvider(binding.providerId, { strict: true });
  return binding;
}
