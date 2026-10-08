/**
 * Onboarding wizard types — step contract and persisted state shape.
 */

import type { ThemeFamily, ThemeMode } from '../theme';

/** Stable step identifiers aligned with MIN-233 flow. */
export type OnboardingStepId =
  | 'welcome'
  | 'theme'
  | 'apps'
  | 'provider-choice'
  | 'provider-local'
  | 'provider-managed'
  | 'provider-cloud'
  | 'provider-cli'
  | 'model-pick'
  | 'extras'
  | 'github'
  | 'permissions'
  | 'memory'
  | 'api-keys'
  | 'context7'
  | 'explainer'
  /** Legacy id — S11 merged into 'explainer'; kept so old persisted records stay typed. */
  | 'demo-chat'
  /** Legacy id — Email setup was removed with the Email app. */
  | 'email'
  | 'done';

/** Per-step completion metadata written on commit or skip. */
export interface OnboardingStepRecord {
  done?: boolean;
  skipped?: boolean;
  /** Opaque step-specific payload (provider id, model id, etc.). */
  data?: Record<string, unknown>;
}

/** Persisted wizard state (`~/.minnow/onboarding.json` + localStorage mirror). */
export interface OnboardingPersistedState {
  version: 1;
  completedAt: string | null;
  lastStep: OnboardingStepId | null;
  overlayClaimedAt: string | null;
  overlayOwner?: string | null;
  overlayExpiresAt?: number | null;
  steps: Partial<Record<OnboardingStepId, OnboardingStepRecord>>;
}

/** Runtime context passed to every step render/commit. */
export interface OnboardingContext {
  state: OnboardingPersistedState;
  /** Selected provider path from S2. */
  providerPath: 'local' | 'managed' | 'cloud' | 'cli' | null;
  providerId: string | null;
  modelId: string | null;
  themeMode: ThemeMode | 'system' | null;
  themeFamily: ThemeFamily | null;
  searxngSkipped: boolean;
  serverAvailable: boolean;
  configServerAvailable: boolean;
}

/** Step plugin contract — one screen per implementation file. */
export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  canSkip: boolean;
  /** Hide step when prerequisites are not met (e.g. S9 when no pending keys). */
  isApplicable(ctx: OnboardingContext): boolean;
  /** Paint step UI into the content mount; return cleanup for listeners. */
  render(
    container: HTMLElement,
    ctx: OnboardingContext,
    actions: OnboardingStepActions,
  ): void | (() => void);
  /** Persist step choices before advancing. */
  commit(ctx: OnboardingContext): Promise<void> | void;
}

/** Navigation callbacks exposed to step UIs. */
export interface OnboardingStepActions {
  next: () => void;
  back: () => void;
  skip: () => void;
  patchContext: (patch: Partial<OnboardingContext>) => void;
  setPrimaryEnabled: (enabled: boolean) => void;
  setPrimaryLabel: (label: string) => void;
  /** Current position in the filtered step list (0-based). */
  readonly stepIndex: number;
  /** Total applicable steps in this run. */
  readonly totalSteps: number;
}
