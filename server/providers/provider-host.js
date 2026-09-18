/**
 * Classify provider base URLs as local (loopback / on-device) vs cloud (remote API).
 * Server mirror of src/providers/provider-host.ts.
 */

import { isLanProviderBaseUrl } from '../../src/lib/lan-provider-host.mjs';

/** @param {string} hostname */
export function isLocalProviderHostname(hostname) {
  const h = String(hostname).trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/** @param {string} baseUrl */
export function isLocalProviderBaseUrl(baseUrl) {
  const trimmed = String(baseUrl ?? '').trim();
  if (!trimmed) return false;
  try {
    return isLocalProviderHostname(new URL(trimmed).hostname);
  } catch {
    return false;
  }
}

const BUILTIN_LOCAL_TEMPLATE_KWARGS_IDS = new Set(['llama-cpp-local', 'mlx-lm-local']);

/**
 * True when chat_template_kwargs / enable_thinking may reach the upstream model.
 * @param {{ id?: string, baseUrl?: string }} provider
 */
export function providerSupportsChatTemplateKwargs(provider) {
  const id = typeof provider?.id === 'string' ? provider.id.trim() : '';
  if (BUILTIN_LOCAL_TEMPLATE_KWARGS_IDS.has(id)) {
    return true;
  }
  return isLocalProviderBaseUrl(provider?.baseUrl) || isLanProviderBaseUrl(provider?.baseUrl);
}
