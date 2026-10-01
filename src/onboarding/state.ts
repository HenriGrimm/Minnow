/**
 * Onboarding persistence — server file wins over localStorage mirror.
 */

import { markOnboardingComplete } from './persistence';
export {
  loadOnboardingState,
  saveOnboardingState,
  markOnboardingComplete,
  resetOnboardingForRerun,
  tryClaimOnboardingOverlay,
  renewOnboardingOverlayClaim,
  releaseOnboardingOverlayClaim,
} from './persistence';
import { listProviders } from '../providers/store';
import { sessionState } from '../state/sessions';
import type { OnboardingPersistedState } from './types';
import { hasExistingChatMessageHistory, hasUserConfiguredProviderIds } from './state-core';

export {
  buildOnboardingContext,
  createDefaultOnboardingState,
  hasExistingChatMessageHistory,
  hasUserConfiguredProviderIds,
  isOnboardingComplete,
  recordStepProgress,
} from './state-core';

function hasRealChatHistory(): boolean {
  return hasExistingChatMessageHistory(sessionState?.chats);
}

async function hasUserConfiguredProviders(): Promise<boolean> {
  try {
    const { providers } = await listProviders();
    return hasUserConfiguredProviderIds(providers.map((p) => p.id));
  } catch {
    return false;
  }
}

/**
 * Existing installs: silently mark complete when chats or custom providers exist.
 * Returns updated state (may be unchanged).
 */
export async function migrateExistingUsersIfNeeded(
  state: OnboardingPersistedState,
): Promise<OnboardingPersistedState> {
  if (state.completedAt) return state;
  if (state.overlayOwner && Number(state.overlayExpiresAt) > Date.now()) return state;
  const [customProviders, chatHistory] = await Promise.all([
    hasUserConfiguredProviders(),
    Promise.resolve(hasRealChatHistory()),
  ]);
  if (!customProviders && !chatHistory) return state;
  return markOnboardingComplete(state);
}
