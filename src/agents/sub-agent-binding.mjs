/** Bindings are inherited as complete pairs, never spliced across providers. */
export function resolveSubAgentBinding(type = {}, parent, routing) {
  for (const [candidate, source] of [[type, 'type'], [routing, 'routing'], [parent, 'parent']]) {
    const modelId = candidate?.modelId?.trim();
    if (!modelId) continue;
    const providerId = candidate?.providerId?.trim() || (source === 'type' ? parent?.providerId?.trim() : '');
    if (!providerId) throw new Error('Choose a provider for the sub-agent model');
    return { providerId, modelId, source };
  }
  throw new Error('No parent model or sub-agent routing model is configured');
}
