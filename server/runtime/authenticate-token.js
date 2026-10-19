/**
 * Shared host/device credential validation for HTTP and WebSocket transports.
 */

import { authenticateDeviceToken } from '../auth/device-store.js';
import { getSessionToken, timingSafeEqualToken } from './session-token.js';

/**
 * Return request identity for a valid host or active device token. The host's
 * per-boot token is honoured only on the loopback desktop listener; on any remote
 * ingress it is just an invalid credential.
 * @param {unknown} token
 * @param {{ throwOnStorageError?: boolean, ingress?: import('../network/ingress.js').IngressKind }} [opts]
 */
export function authenticateMinnowToken(token, { throwOnStorageError = false, ingress = 'loopback' } = {}) {
  if (ingress === 'loopback' && timingSafeEqualToken(token, getSessionToken())) {
    return { kind: 'host' };
  }
  try {
    return authenticateDeviceToken(token);
  } catch (err) {
    if (throwOnStorageError) throw err;
    return null;
  }
}
