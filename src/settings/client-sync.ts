/**
 * Apply client-side settings patches after update_settings and refresh UI sections.
 */

import { resetSearchConfigCache } from '../config/search-config';
import {
  loadDiagnosticsPrefs,
  saveDiagnosticsPref,
} from '../diagnostics/prefs';
import { loadNotificationPrefs, saveNotificationPref } from '../notifications/prefs';
import {
  getFollowSystem,
  getStoredFamily,
  getStoredTheme,
  setFollowSystem,
  setThemeFamily,
  setThemeMode,
  type ThemeFamily,
  type ThemeMode,
} from '../theme';
import { getFieldByKey } from './field-registry';
import type { SettingsSectionId } from '../ui/settings-page-types';
import { refreshSettingsSection } from '../ui/settings-sections';

/** Apply server-returned clientPatches from update_settings. */
export async function applySettingsClientPatches(
  patches: Record<string, unknown> | undefined,
): Promise<void> {
  if (!patches || typeof patches !== 'object') return;

  for (const [patchKey, value] of Object.entries(patches)) {
    if (patchKey === 'notifications.enabled') {
      saveNotificationPref('enabled', Boolean(value));
    } else if (patchKey === 'notifications.chatEnabled') {
      saveNotificationPref('chatEnabled', Boolean(value));
    } else if (patchKey === 'notifications.tasksEnabled') {
      saveNotificationPref('tasksEnabled', Boolean(value));
    } else if (patchKey === 'notifications.backgroundEnabled') {
      saveNotificationPref('backgroundEnabled', Boolean(value));
    } else if (patchKey === 'notifications.soundEnabled') {
      saveNotificationPref('soundEnabled', Boolean(value));
    } else if (patchKey === 'notifications.osEnabled') {
      saveNotificationPref('osEnabled', Boolean(value));
    } else if (patchKey === 'notifications.soundOnActiveChat') {
      saveNotificationPref('soundOnActiveChat', Boolean(value));
    } else if (patchKey === 'notifications.soundPackId' && typeof value === 'string') {
      saveNotificationPref('soundPackId', value);
    } else if (patchKey === 'notifications.soundId' && typeof value === 'string') {
      saveNotificationPref('soundPackId', value === 'none' ? 'none' : 'default');
    } else if (patchKey === 'theme.family' && typeof value === 'string') {
      setThemeFamily(value as ThemeFamily);
    } else if (patchKey === 'theme.mode') {
      if (value === 'system') {
        setFollowSystem(true);
      } else if (value === 'dark' || value === 'light') {
        setFollowSystem(false);
        setThemeMode(value as ThemeMode);
      }
    } else if (patchKey === 'diagnostics.fileErrorsToIssues') {
      saveDiagnosticsPref('fileErrorsToIssues', Boolean(value));
    }
  }
}

/** Collect refresh areas for applied setting keys. */
export function refreshAreasForKeys(keys: string[]): SettingsSectionId[] {
  const areas = new Set<SettingsSectionId>();
  for (const key of keys) {
    const field = getFieldByKey(key);
    for (const area of field?.refreshAreas ?? []) {
      areas.add(area);
    }
  }
  return [...areas];
}

/** Post-success hook for settings agent tools. */
export async function afterSettingsToolSuccess(
  toolName: string,
  resultContent: string,
): Promise<void> {
  if (toolName !== 'update_settings') return;

  let payload: {
    applied?: { key: string }[];
    clientPatches?: Record<string, unknown>;
  };
  try {
    payload = JSON.parse(resultContent) as typeof payload;
  } catch {
    return;
  }

  await applySettingsClientPatches(payload.clientPatches);

  const appliedKeys = (payload.applied ?? []).map((row) => row.key);
  if (appliedKeys.some((k) => k.startsWith('integrations.search'))) {
    resetSearchConfigCache();
  }

  const areas = refreshAreasForKeys(appliedKeys);
  for (const area of areas) {
    await refreshSettingsSection(area);
  }

  window.dispatchEvent(
    new CustomEvent('minnow:settings-changed', { detail: { keys: appliedKeys } }),
  );
}

/** Read one browser-backed field from localStorage modules. */
function readBrowserFieldValue(key: string): unknown {
  if (key.startsWith('general.notifications.')) {
    const prefs = loadNotificationPrefs();
    const map: Record<string, unknown> = {
      'general.notifications.enabled': prefs.enabled,
      'general.notifications.chat': prefs.chatEnabled,
      'general.notifications.tasks': prefs.tasksEnabled,
      'general.notifications.background': prefs.backgroundEnabled,
      'general.notifications.os': prefs.osEnabled,
      'general.notifications.sound': prefs.soundEnabled,
      'general.notifications.soundOnActiveChat': prefs.soundOnActiveChat,
    };
    return map[key] ?? null;
  }

  if (key === 'appearance.theme.family') {
    return getStoredFamily();
  }

  if (key === 'appearance.theme.mode') {
    if (getFollowSystem()) return 'system';
    const theme = getStoredTheme();
    return theme?.endsWith('-light') ? 'light' : 'dark';
  }

  if (key === 'advanced.diagnostics.fileErrorsToIssues') {
    return loadDiagnosticsPrefs().fileErrorsToIssues;
  }

  return null;
}

/** Enrich get_settings JSON with browser-only field values from localStorage. */
export function augmentGetSettingsResult(resultContent: string): string {
  let payload: {
    values?: { key: string; label: string; value: unknown }[];
    errors?: { key: string; error: string }[];
  };
  try {
    payload = JSON.parse(resultContent) as typeof payload;
  } catch {
    return resultContent;
  }

  if (!Array.isArray(payload.errors) || !payload.errors.length) {
    return resultContent;
  }

  const browserReads: { key: string; label: string; value: unknown }[] = [];
  const remainingErrors = payload.errors.filter((err) => {
    const field = getFieldByKey(err.key);
    if (field?.storage !== 'browser') return true;
    browserReads.push({
      key: err.key,
      label: field.label,
      value: readBrowserFieldValue(err.key),
    });
    return false;
  });

  if (!browserReads.length) return resultContent;

  return JSON.stringify(
    {
      values: [...(payload.values ?? []), ...browserReads],
      errors: remainingErrors.length ? remainingErrors : undefined,
    },
    null,
    2,
  );
}
