export interface SubAgentBinding { providerId?: string; modelId?: string }
export function resolveSubAgentBinding(type?: SubAgentBinding, parent?: SubAgentBinding, routing?: SubAgentBinding | null): { providerId: string; modelId: string; source: 'type' | 'routing' | 'parent' };
