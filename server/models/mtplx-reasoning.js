import { normalizeReasoningAllowedOptions, normalizeReasoningCatalogValue } from '../runner/reasoning-effort.js';

/** Shared by My Models and its served aliases; descriptors win over name guesses. */
export function mtplxReasoningCatalog(descriptor, settings) {
  const control = descriptor?.reasoning;
  if (!control) return undefined;
  if (control.supported === false) return { source: 'mtplx', allowed_options: ['off'], default: 'off' };
  const levels = normalizeReasoningAllowedOptions(control.effortLevels ?? []).filter((level) => level !== 'off' && level !== 'on');
  const allowed = normalizeReasoningAllowedOptions([...(control.modes ?? []), ...levels]);
  const mode = settings?.reasoning ?? control.defaultMode;
  const configured = normalizeReasoningCatalogValue(settings?.reasoning_effort);
  const familyDefault = normalizeReasoningCatalogValue(control.defaultEffort);
  const preferredLevel = levels.find((level) => level === configured)
    ?? levels.find((level) => level === familyDefault) ?? levels[0];
  const preferred = mode === 'off' && allowed.includes('off')
    ? 'off'
    : preferredLevel ?? (allowed.includes('on') ? 'on' : allowed[0]);
  return { source: 'mtplx', allowed_options: allowed, default: preferred };
}
