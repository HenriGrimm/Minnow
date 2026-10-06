/**
 * Shared host/device credential validation for HTTP and WebSocket transports.
 */

import { authenticateDeviceToken } from '../auth/device-store.js';
import { getSessionToken, timingSafeEqualToken } from './session-token.js';

/** Return request identity for a valid host or active device token. */
export function authenticateMinnowToken(token, { throwOnStorageError = false } = {}) {
  if (timingSafeEqualToken(token, getSessionToken())) {
    return { kind: 'host' };
  }
  try {
    return authenticateDeviceToken(token);
  } catch (err) {
    if (throwOnStorageError) throw err;
    return null;
  }
}

