import { inferReasoningOptionsFromModelId, normalizeReasoningAllowedOptions } from '../runner/reasoning-effort.js';

/** Shared by My Models and its served aliases; descriptors win over name guesses. */
export function mtplxReasoningCatalog(modelId, descriptor) {
  const control = descriptor?.reasoning;
  if (control?.supported === false) return { allowed_options: ['off'], default: 'off' };
  const advertised = control ? [...(control.modes ?? []).filter(mode => mode !== 'auto'), ...(control.effortLevels ?? [])] : [];
  const allowed = normalizeReasoningAllowedOptions(advertised.length ? advertised : inferReasoningOptionsFromModelId(modelId, undefined));
  if (!allowed.length) return undefined;
  const preferred = control?.defaultMode === 'off' ? 'off' : control?.defaultEffort;
  return { allowed_options: allowed, default: allowed.includes(preferred) ? preferred : allowed.includes('high') ? 'high' : allowed[0] };
}
