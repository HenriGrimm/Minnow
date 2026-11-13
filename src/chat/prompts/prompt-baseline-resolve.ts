import {
  fetchWorkAgentBuiltinBaseline,
} from '../../agents/work-agent-prompt-api';
import {
  fetchPromptBuiltinBaseline,
  type PromptFileFamily,
} from './prompt-file-api';
import { loadBuiltinPromptById } from './prompt-loader';

export async function resolveFilePromptBuiltinBaseline(
  family: PromptFileFamily,
  entityId: string,
): Promise<string> {
  const fromApi = await fetchPromptBuiltinBaseline(family, entityId);
  if (fromApi?.content != null) return fromApi.content;
  if (family === 'modes') {
    return loadBuiltinPromptById('mode', entityId)?.body?.trim() ?? '';
  }
  if (family === 'experts') {
    return loadBuiltinPromptById('expert', entityId)?.body?.trim() ?? '';
  }
  return '';
}

export async function resolveWorkAgentBuiltinBaselineText(
  agentId: string,
): Promise<string> {
  const fromApi = await fetchWorkAgentBuiltinBaseline(agentId);
  if (fromApi?.content != null) return fromApi.content;
  return loadBuiltinPromptById('work-agent', agentId)?.body?.trim() ?? '';
}
