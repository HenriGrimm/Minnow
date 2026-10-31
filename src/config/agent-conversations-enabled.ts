import {
  validateAgentConversationsFeature,
  type AgentConversationsFeature,
} from '../../server/chats/contracts.js';

/** A renderer never enables creation from local storage or a browser env flag. */
export function readAgentConversationsCapability(value: unknown): AgentConversationsFeature | null {
  const { conversationStorage: _storage, clientProtocol: _protocol, ...feature } = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (_protocol !== undefined) {
    const protocol = _protocol as Record<string, unknown> | null;
    if (!protocol || protocol.version !== 1 || protocol.minReaderVersion !== 1 || protocol.minWriterVersion !== 1) return null;
  }
  const parsed = validateAgentConversationsFeature(feature);
  return parsed.ok ? parsed.value : null;
}

export function isAgentConversationsEnabled(serverCapability: unknown): boolean {
  return readAgentConversationsCapability(serverCapability)?.creationEnabled === true;
}

let capability: AgentConversationsFeature | null = null;
let conversationStorage: 'sqlite' | 'json' | null = null;
let refreshedAt = 0;
let pending: Promise<AgentConversationsFeature | null> | undefined;

export function getAgentConversationsCapabilitySync(): AgentConversationsFeature | null { return capability; }
export function getConversationStorageCapabilitySync(): 'sqlite' | 'json' | null { return conversationStorage; }

function readStorage(value: unknown): 'sqlite' | 'json' | null {
  const storage = (value as { conversationStorage?: unknown } | null)?.conversationStorage;
  return storage === 'sqlite' || storage === 'json' ? storage : null;
}

/** Presentation uses one advertised server snapshot; the server still authorizes every write. */
export async function loadAgentConversationsCapability(): Promise<AgentConversationsFeature | null> {
  if (Date.now() - refreshedAt < 15_000) return capability;
  pending ??= (async () => {
    try {
      const response = await fetch('/api/chats/capabilities', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) return capability;
      const body = await response.json();
      const value = readAgentConversationsCapability(body);
      if (value) { capability = Object.freeze(value); conversationStorage = readStorage(body); }
      return capability;
    } catch { return capability; }
    finally { refreshedAt = Date.now(); pending = undefined; }
  })();
  return pending;
}

export function setAgentConversationsCapabilityForTests(value?: unknown): void {
  capability = readAgentConversationsCapability(value);
  conversationStorage = capability ? readStorage(value) : null;
  refreshedAt = value === undefined ? 0 : Number.POSITIVE_INFINITY;
  pending = undefined;
}
