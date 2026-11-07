import {
  validateAgentConversationsFeature,
  type AgentConversationsFeature,
  type OrdinaryChatExecutionFeature,
} from '../../server/chats/contracts.js';

/** A renderer never enables creation from local storage or a browser env flag. */
export function readAgentConversationsCapability(value: unknown): AgentConversationsFeature | null {
  const { conversationStorage: _storage, clientProtocol: _protocol, ordinaryExecution: _ordinary, ...feature } = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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

/** Ordinary admission requires the complete modern protocol, not the agent creation flag. */
export function readOrdinaryChatExecutionCapability(value: unknown): OrdinaryChatExecutionFeature | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, any>, ordinary = body.ordinaryExecution, protocol = body.clientProtocol;
  if (body.conversationStorage !== 'sqlite' || !readAgentConversationsCapability(value) ||
      !protocol || protocol.version !== 1 || protocol.minReaderVersion !== 1 || protocol.minWriterVersion !== 1 ||
      !ordinary || ordinary.version !== 1 || ordinary.capability !== 'ordinaryChatExecutionV1' ||
      ['admissionEnabled', 'promotionEnabled', 'recoveryEnabled'].some(key => typeof ordinary[key] !== 'boolean') ||
      !['released', 'disabled', 'parity_required', 'storage_unsupported'].includes(ordinary.reason) ||
      !Array.isArray(ordinary.blockers) || ordinary.blockers.length > 64 ||
      ordinary.blockers.some((item: unknown) => typeof item !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(item)) ||
      (ordinary.admissionEnabled || ordinary.promotionEnabled) && (!ordinary.recoveryEnabled || ordinary.blockers.length || ordinary.reason !== 'released')) return null;
  return Object.freeze({ version: 1, capability: 'ordinaryChatExecutionV1', admissionEnabled: ordinary.admissionEnabled,
    promotionEnabled: ordinary.promotionEnabled, recoveryEnabled: ordinary.recoveryEnabled, reason: ordinary.reason,
    blockers: Object.freeze([...ordinary.blockers]) });
}

let capability: AgentConversationsFeature | null = null;
let ordinaryCapability: OrdinaryChatExecutionFeature | null = null;
let conversationStorage: 'sqlite' | 'json' | null = null;
let refreshedAt = 0;
let pending: Promise<AgentConversationsFeature | null> | undefined;

export function getAgentConversationsCapabilitySync(): AgentConversationsFeature | null { return capability; }
export function getConversationStorageCapabilitySync(): 'sqlite' | 'json' | null { return conversationStorage; }
export function getOrdinaryChatExecutionCapabilitySync(): OrdinaryChatExecutionFeature | null { return ordinaryCapability; }
export async function loadOrdinaryChatExecutionCapability(): Promise<OrdinaryChatExecutionFeature | null> {
  await loadAgentConversationsCapability();
  return ordinaryCapability;
}

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
      if (!response.ok) { ordinaryCapability = null; return capability; }
      const body = await response.json();
      const value = readAgentConversationsCapability(body);
      ordinaryCapability = readOrdinaryChatExecutionCapability(body);
      if (value) { capability = Object.freeze(value); conversationStorage = readStorage(body); }
      return capability;
    } catch { ordinaryCapability = null; return capability; }
    finally { refreshedAt = Date.now(); pending = undefined; }
  })();
  return pending;
}

export function setAgentConversationsCapabilityForTests(value?: unknown): void {
  capability = readAgentConversationsCapability(value);
  ordinaryCapability = readOrdinaryChatExecutionCapability(value);
  conversationStorage = capability ? readStorage(value) : null;
  refreshedAt = value === undefined ? 0 : Number.POSITIVE_INFINITY;
  pending = undefined;
}
