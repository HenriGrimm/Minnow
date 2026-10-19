/**
 * The name a phone shows for this computer ("Connect to Henri's MacBook Pro?").
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';

/** @type {string | null} */
let cached = null;

export function getHostDisplayName() {
  if (cached) return cached;
  let name = '';
  if (process.platform === 'darwin') {
    try {
      name = execFileSync('scutil', ['--get', 'ComputerName'], {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      /* fall back to the network hostname */
    }
  }
  if (!name) name = os.hostname().replace(/\.local$/i, '');
  cached = name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64) || 'Minnow';
  return cached;
}

/** DNS-safe label derived from the computer name, for the tailnet node. */
export function getTailnetNodeName() {
  const base = os
    .hostname()
    .replace(/\.local$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `minnow-${base || 'host'}`;
}
