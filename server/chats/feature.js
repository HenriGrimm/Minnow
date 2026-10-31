import {
  AGENT_CONVERSATIONS_CAPABILITY,
  CHAT_CONTRACT_VERSION,
} from './contracts.js';

/** Activation belongs to the release gate, never a persisted user preference. */
export const AGENT_CONVERSATIONS_RELEASED = true;

/**
 * Only the server evaluates environment opt-in. Existing versioned records must
 * remain recoverable when creation is disabled; this flag never starts work.
 */
export function getAgentConversationsFeature(env = process.env) {
  const optedIn = env.MINNOW_AGENT_CONVERSATIONS === '1';
  const disabled = env.MINNOW_AGENT_CONVERSATIONS === '0';
  const development = env.NODE_ENV !== 'production'
    && (env.MINNOW_DEBUG === '1' || env.NODE_ENV === 'test');
  const creationEnabled = !disabled && (AGENT_CONVERSATIONS_RELEASED || (optedIn && development));
  return Object.freeze({
    version: CHAT_CONTRACT_VERSION,
    capability: AGENT_CONVERSATIONS_CAPABILITY,
    creationEnabled,
    recoveryEnabled: true,
    reason: disabled ? 'disabled' : AGENT_CONVERSATIONS_RELEASED ? 'released'
      : creationEnabled ? 'development_opt_in' : 'not_released',
  });
}
