/**
 * Build outbound HTTP headers for provider upstream requests (proxy mode).
 */

import { mergeOpenCodeIdentityHeaders } from './opencode-identity.js';

/**
 * @param {object} profile
 * @param {object} secrets
 * @returns {Record<string, string>}
 */
export function buildAuthHeaders(profile, secrets) {
  if (profile?.apiKind === 'agent-cli-v1') return {};
  const headers = {};

  if (profile?.customHeaders && typeof profile.customHeaders === 'object') {
    for (const [key, value] of Object.entries(profile.customHeaders)) {
      if (typeof value === 'string') {
        headers[key] = value;
      }
    }
  }

  const bearerToken =
    typeof secrets?.bearerToken === 'string' ? secrets.bearerToken.trim() : '';
  const apiKey = typeof secrets?.apiKey === 'string' ? secrets.apiKey.trim() : '';

  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  } else if (apiKey) {
    const style = profile?.authStyle || 'bearer';
    if (style === 'api-key') {
      headers['api-key'] = apiKey;
    } else if (style === 'x-api-key') {
      headers['x-api-key'] = apiKey;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }

  if (secrets?.headerOverrides && typeof secrets.headerOverrides === 'object') {
    for (const [key, value] of Object.entries(secrets.headerOverrides)) {
      if (typeof value === 'string') {
        headers[key] = value;
      }
    }
  }

  // OpenCode Go rejects generic SDK/undici User-Agents; stamp Minnow last.
  return mergeOpenCodeIdentityHeaders(headers, { baseUrl: profile?.baseUrl });
}

/**
 * @param {object} secrets
 * @returns {{ hasApiKey: boolean, hasBearer: boolean }}
 */
export function secretsFlags(secrets) {
  const apiKey = typeof secrets?.apiKey === 'string' ? secrets.apiKey.trim() : '';
  const bearerToken =
    typeof secrets?.bearerToken === 'string' ? secrets.bearerToken.trim() : '';
  return {
    hasApiKey: apiKey.length > 0,
    hasBearer: bearerToken.length > 0,
  };
}
