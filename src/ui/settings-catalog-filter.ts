import { isDeveloperReleased, isAppId } from '../os/app-registry';
import type { AppId } from '../os/types';
import type { SettingsFieldEntry } from './settings-catalog';

const OPTIONAL_APP_KEY_PREFIX = 'apps.optional.';

/** Drop search rows for hidden optional apps and dev-only advanced tools. */
export function filterSettingsCatalogEntries(
  entries: readonly SettingsFieldEntry[],
): SettingsFieldEntry[] {
  return entries.filter((entry) => {
    if (entry.area === 'board-testing' || entry.area === 'capability-matrix') {
      return false;
    }
    if (entry.key === 'agents.experts' && !isDeveloperReleased('experts')) {
      return false;
    }
    if (!entry.key.startsWith(OPTIONAL_APP_KEY_PREFIX)) {
      return true;
    }
    const rest = entry.key.slice(OPTIONAL_APP_KEY_PREFIX.length);
    const appSegment = rest.split('.')[0] ?? '';
    if (!isAppId(appSegment)) {
      return true;
    }
    return isDeveloperReleased(appSegment as AppId);
  });
}
