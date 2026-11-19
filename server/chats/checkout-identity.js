import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ChatContractError } from './contracts.js';

export const checkoutKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
export const identity = (prefix, value) => `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;

export async function directory(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new ChatContractError('workspace_denied', 'A registered project directory is required');
  }
  try {
    const resolved = await fs.realpath(value);
    if (!(await fs.stat(resolved)).isDirectory()) throw new Error('Not a directory');
    return resolved;
  } catch {
    throw new ChatContractError('workspace_denied', 'The conversation checkout is unavailable');
  }
}

/** Execution directory identity, stable across ordinary file writes and Git initialization. */
export async function readChatCheckoutIdentity(value) {
  try {
    const canonical = await directory(value);
    const stat = await fs.stat(canonical, { bigint: true });
    if (stat.ino === 0n || stat.birthtimeNs === 0n) throw new Error('Unverifiable directory identity');
    return identity('checkout', JSON.stringify([checkoutKey(canonical), String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]));
  } catch {
    throw new ChatContractError('workspace_denied', 'Cannot verify the conversation checkout identity');
  }
}
