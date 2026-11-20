/**
 * Memory enablement helpers for settings and onboarding.
 *
 * Memory is never injected into prompts: agents search it on demand with
 * memory_search. The retired `features.memoryInjection` flag and per-chat
 * `brainNotesInjection` field are ignored and no longer written.
 */

import { readConfigFile, writeConfigFile } from '../config/config-file-cache';
import type { Chat } from '../types';

/** Per-chat override: null = follow global. */
export function isMemoryEnabledForChat(
  chat: Chat,
  globalEnabled: boolean,
): boolean {
  const row = chat as Chat & { memoryEnabled?: boolean | null };
  if (row.memoryEnabled === true) return true;
  if (row.memoryEnabled === false) return false;
  return globalEnabled;
}

/** Persist the memory store toggle (Settings / onboarding). */
export async function saveMemorySettings(options: {
  storeEnabled?: boolean;
}): Promise<boolean> {
  const config = await readConfigFile({ fresh: true });
  if (!config) return false;

  if (typeof options.storeEnabled === 'boolean') {
    const memory = config.memory;
    config.memory = {
      ...(memory && typeof memory === 'object' ? (memory as Record<string, unknown>) : {}),
      enabled: options.storeEnabled,
    };
  }

  return writeConfigFile(config);
}
