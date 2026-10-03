/**
 * Pure onboarding state helpers (no I/O) — safe for unit tests.
 */

import type { OnboardingContext, OnboardingPersistedState, OnboardingStepId } from './types';

/** Provider ids seeded on first `npm start` — not treated as user configuration. */
export const ONBOARDING_SEED_PROVIDER_IDS = new Set([
  'lm-studio-local',
  'llama-cpp-local',
  'vite-fallback',
]);

/** True when the user added a provider beyond the shipped seed rows. */
export function hasUserConfiguredProviderIds(providerIds: readonly string[]): boolean {
  return providerIds.some((id) => !ONBOARDING_SEED_PROVIDER_IDS.has(id));
}

/** Prefix for cloud providers saved during onboarding (one row per preset id). */
export const ONBOARDING_CLOUD_PROVIDER_PREFIX = 'onboarding-cloud-';

/** Stable provider id for an onboarding cloud preset chip. */
export function onboardingCloudProviderId(presetId: string): string {
  return `${ONBOARDING_CLOUD_PROVIDER_PREFIX}${presetId}`;
}

/** Map a saved onboarding cloud provider id back to its preset chip id. */
export function presetIdFromOnboardingCloudProviderId(providerId: string): string | null {
  if (!providerId.startsWith(ONBOARDING_CLOUD_PROVIDER_PREFIX)) return null;
  return providerId.slice(ONBOARDING_CLOUD_PROVIDER_PREFIX.length);
}

/** Preset chip ids that already have an API key saved during onboarding. */
export function listConfiguredOnboardingCloudPresetIds(
  providers: ReadonlyArray<{ id: string; hasApiKey: boolean }>,
): string[] {
  const configured: string[] = [];
  for (const provider of providers) {
    if (!provider.hasApiKey) continue;
    const presetId = presetIdFromOnboardingCloudProviderId(provider.id);
    if (presetId) configured.push(presetId);
  }
  return configured;
}

/** True when persisted chats contain real messages (not just model binding). */
export function hasExistingChatMessageHistory(
  chats: ReadonlyArray<{ history?: readonly unknown[] }> | undefined,
): boolean {
  if (!chats?.length) return false;
  return chats.some((chat) => (chat.history?.length ?? 0) > 0);
}

/** Empty wizard state for first launch. */
export function createDefaultOnboardingState(): OnboardingPersistedState {
  return {
    version: 1,
    completedAt: null,
    lastStep: null,
    overlayClaimedAt: null,
    steps: {},
  };
}

export function isOnboardingComplete(state: OnboardingPersistedState): boolean {
  return Boolean(state.completedAt);
}

interface OnboardingStepRecordPatch {
  done?: boolean;
  skipped?: boolean;
  data?: Record<string, unknown>;
}

export function recordStepProgress(
  state: OnboardingPersistedState,
  stepId: OnboardingStepId,
  patch: OnboardingStepRecordPatch,
): OnboardingPersistedState {
  const prev = state.steps[stepId] ?? {};
  return {
    ...state,
    lastStep: stepId,
    steps: {
      ...state.steps,
      [stepId]: {
        ...prev,
        ...(patch.done ? { skipped: false } : {}),
        ...patch,
        data: patch.data ? { ...(prev.data ?? {}), ...patch.data } : prev.data,
      },
    },
  };
}

/** Build runtime context from persisted state + boot probes. */
export function buildOnboardingContext(
  state: OnboardingPersistedState,
  options: { serverAvailable: boolean; configServerAvailable: boolean },
): OnboardingContext {
  const themeStep = state.steps.theme?.data ?? {};
  const chosenPath = state.steps['provider-choice']?.data?.path as OnboardingContext['providerPath'] | undefined;
  const providerStep = chosenPath !== undefined
    ? (chosenPath ? state.steps[`provider-${chosenPath}`]?.data ?? {} : {})
    : state.steps['provider-local']?.data ??
    state.steps['provider-cloud']?.data ??
    state.steps['provider-managed']?.data ??
    state.steps['provider-choice']?.data ??
    {};
  const modelStep = state.steps['model-pick']?.data ?? {};

  return {
    state,
    providerPath:
      chosenPath ?? (providerStep.path as OnboardingContext['providerPath']) ??
      (state.steps['provider-choice']?.data?.path as OnboardingContext['providerPath']) ??
      null,
    providerId: (providerStep.providerId as string) ?? (chosenPath === undefined ? (modelStep.providerId as string) : null) ?? null,
    modelId: chosenPath === 'managed' ? (providerStep.modelId as string) ?? null
      : modelStep.providerId === providerStep.providerId ? (modelStep.modelId as string) ?? null : null,
    themeMode: (themeStep.mode as OnboardingContext['themeMode']) ?? null,
    themeFamily: (themeStep.family as OnboardingContext['themeFamily']) ?? null,
    searxngSkipped: Boolean(state.steps.extras?.data?.searxngSkipped),
    serverAvailable: options.serverAvailable,
    configServerAvailable: options.configServerAvailable,
  };
}
