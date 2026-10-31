/**
 * Resolve per-model API pricing and compute USD cost from provider usage.
 */

import type { Usage } from '../types';
import type { ModelPricingRates, ProviderPricing } from './types.ts';

/** Normalize rates object; reject negative or non-finite values. */
export function normalizeModelPricingRates(raw: unknown): ModelPricingRates | null {
  if (!raw || typeof raw !== 'object') return null;
  const inputPer1M = Number((raw as ModelPricingRates).inputPer1M);
  const outputPer1M = Number((raw as ModelPricingRates).outputPer1M);
  if (!Number.isFinite(inputPer1M) || !Number.isFinite(outputPer1M)) return null;
  if (inputPer1M < 0 || outputPer1M < 0) return null;
  return { inputPer1M, outputPer1M };
}

/** Validate pricing block shape for API persistence. */
export function normalizeProviderPricing(raw: unknown): ProviderPricing | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as ProviderPricing;
  const out: ProviderPricing = {};
  if (typeof src.currency === 'string' && src.currency.trim()) {
    out.currency = src.currency.trim().toUpperCase();
  }
  const defaultRates = normalizeModelPricingRates(src.default);
  if (defaultRates) out.default = defaultRates;
  if (src.models && typeof src.models === 'object') {
    const models: Record<string, ModelPricingRates> = {};
    for (const [key, value] of Object.entries(src.models)) {
      if (typeof key !== 'string' || !key.trim()) continue;
      const rates = normalizeModelPricingRates(value);
      if (rates) models[key.trim()] = rates;
    }
    if (Object.keys(models).length > 0) out.models = models;
  }
  if (!out.default && !out.models) return null;
  return out;
}



/**
 * Fill `total_tokens` from prompt + completion when the provider omitted it.
 * Keeps an existing finite `total_tokens` unchanged.
 */
export { normalizeUsageTotals } from '../../server/runner/response-meta.js';



export { resolveModelPricing, usageTokenCounts, hasMeasurableUsage, computeCostUsd } from '../../server/runner/usage-pricing.js';
