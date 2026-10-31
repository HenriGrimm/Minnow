import type { Usage } from '../../src/types';
import type { ModelPricingRates, ProviderPricing } from '../../src/usage/types';
export function resolveModelPricing(pricing: ProviderPricing | null | undefined, modelId: string): ModelPricingRates;
export function usageTokenCounts(usage: Usage): { promptTokens: number; completionTokens: number; totalTokens: number };
export function hasMeasurableUsage(usage: Usage | null | undefined): boolean;
export function computeCostUsd(usage: Usage, rates: ModelPricingRates): number | null;
