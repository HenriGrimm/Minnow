/**
 * Single source of truth for Impeccable harness commands (reference-driven workflows).
 * Command list is vendored in harness-commands.mjs (regenerated from pin.mjs on impeccable:sync).
 * The JSON twin is extraResources-only for skill install and must not be imported from app.asar.
 */

import harnessCommands from './harness-commands.mjs';

/** Legacy slash alias → canonical harness command (init replaced teach in v3). */
export const HARNESS_ALIASES = Object.freeze({
  teach: 'init',
});

/** Harness commands from upstream pin.mjs (reference/*.md workflows). */
export const HARNESS_COMMANDS = new Set(harnessCommands);

/**
 * Resolve a user-facing sub-command to its canonical harness name.
 * @param {string} cmd
 * @returns {string | null}
 */
export function resolveHarnessCommand(cmd) {
  const normalized = String(cmd ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (Object.hasOwn(HARNESS_ALIASES, normalized)) {
    return HARNESS_ALIASES[normalized];
  }
  if (HARNESS_COMMANDS.has(normalized)) {
    return normalized;
  }
  return null;
}

/**
 * Canonical harness command names (sorted).
 * @returns {string[]}
 */
export function listHarnessCommandNames() {
  return [...HARNESS_COMMANDS].sort();
}

/**
 * @param {string} cmd
 * @returns {boolean}
 */
export function isHarnessCommandName(cmd) {
  return resolveHarnessCommand(cmd) !== null;
}
