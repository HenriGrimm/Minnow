/**
 * Learn how far the character-based token estimate sits from a model's real
 * tokenizer from provider overflow numbers.
 */

export function recordContextEstimateBias(
  modelId: string,
  requestTokens: number,
  estimatedMessageTokens: number,
  reservedTokens?: number,
): void;

/** Learned real-per-estimated ratio for a model, or null when never measured. */
export function contextEstimateBias(modelId: string): number | null;

/**
 * Message-estimate ceiling for a model whose bias has been measured — null when
 * it has not, leaving the caller on the ordinary margin-and-reserve budget.
 */
export function contextCalibratedMessageLimit(
  modelId: string,
  modelLimit: number | null,
  safetyMargin: number,
  reservedTokens?: number,
): number | null;

/** Remember the real n_ctx a host reported in a context-overflow error. */
export function recordObservedContextWindow(
  providerId: string,
  modelId: string,
  limitTokens: number,
): void;

/** Host-reported window for this provider + model, or null when never observed. */
export function observedContextWindow(providerId: string, modelId: string): number | null;

/** Forget the observed window once a round proves the host now has a larger one. */
export function noteContextWindowUsage(
  providerId: string,
  modelId: string,
  usedTokens: number,
): void;

/** The smaller of a resolved model window and an observed one; either may be null. */
export function narrowContextLimit(
  resolved: number | null | undefined,
  observed: number | null | undefined,
): number | null;

/** Test seam — calibration is process-lifetime state. */
export function resetContextEstimateCalibrationForTests(): void;
