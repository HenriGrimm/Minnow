/**
 * Classify provider base URLs as local (loopback / on-device) vs cloud (remote API).
 */

import {
  LLAMA_CPP_LOCAL_PROVIDER_ID,
  MLX_LM_LOCAL_PROVIDER_ID,
  type ProviderPublic,
} from './types';
import { isLanProviderBaseUrl } from '../lib/lan-provider-host.mjs';

/** Built-in provider ids that always resolve to local inference. */
export const KNOWN_LOCAL_PROVIDER_IDS = new Set(['lm-studio-local', 'vite-fallback']);

/** Minnow's own local serves — always on-device regardless of how the URL reads. */
const BUILTIN_LOCAL_SERVE_IDS = new Set<string>([
  LLAMA_CPP_LOCAL_PROVIDER_ID,
  MLX_LM_LOCAL_PROVIDER_ID,
]);

/** True when the hostname points at loopback inference (LM Studio, Ollama, etc.). */
export function isLocalProviderHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/** True when the provider base URL targets a loopback host. */
export function isLocalProviderBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) return false;
  try {
    return isLocalProviderHostname(new URL(trimmed).hostname);
  } catch {
    return false;
  }
}

/** True for seeded / vite-only provider ids (no registry lookup). */
export function isKnownLocalProviderId(providerId: string): boolean {
  return KNOWN_LOCAL_PROVIDER_IDS.has(providerId.trim());
}

/**
 * True when chat_template_kwargs / enable_thinking may reach the upstream model.
 * Covers Minnow local serves plus loopback/LAN inference runtimes (MTPLX, etc.).
 */
export function providerSupportsChatTemplateKwargs(
  provider: Pick<ProviderPublic, 'id' | 'baseUrl'>,
): boolean {
  if (BUILTIN_LOCAL_SERVE_IDS.has(provider.id.trim())) {
    return true;
  }
  return isLocalProviderBaseUrl(provider.baseUrl) || isLanProviderBaseUrl(provider.baseUrl);
}

/**
 * True when inference for this provider runs on this machine.
 *
 * Callers use it to decide whether the renderer is competing with the model for local
 * hardware — see `ui/motion-ticker.ts`, which steps animation down to STEP_HZ (20 Hz) so the GPU's
 * 3D queue is not shared with a spinner during decode.
 */
export function isLocalProvider(provider: Pick<ProviderPublic, 'id' | 'baseUrl'>): boolean {
  const id = provider.id.trim();
  if (BUILTIN_LOCAL_SERVE_IDS.has(id) || isKnownLocalProviderId(id)) return true;
  return isLocalProviderBaseUrl(provider.baseUrl);
}
