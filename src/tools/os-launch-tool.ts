import { fieldByKey } from '../ui/settings-catalog';
import { resolveBrainMemoryRoute } from '../ui/brain-memory-routing';
import { categoryForArea, type SettingsSectionId } from '../ui/settings-page-types';
import { buildSettingsSearchIndex } from '../ui/settings-search-index';
import { rankSettingsSearch } from '../ui/settings-search-rank';
import { getAppById, isAppId } from '../os/app-registry';
import { isAppAvailable } from '../os/app-preferences';
import { launchApp as defaultLaunchApp } from '../os/router';
import type { AppId, LaunchOptions } from '../os/types';

const APP_ID_ARG = 'app_id';

function resolveSettingsDeepLink(args: Record<string, unknown>): Pick<
  LaunchOptions,
  'settingsSection' | 'settingsSearchKey'
> {
  const out: Pick<LaunchOptions, 'settingsSection' | 'settingsSearchKey'> = {};

  if (typeof args.settings_query === 'string' && args.settings_query.trim()) {
    const ranked = rankSettingsSearch(args.settings_query.trim(), buildSettingsSearchIndex(), {
      maxResults: 1,
    });
    const best = ranked[0];
    if (best?.searchKey) {
      out.settingsSearchKey = best.searchKey;
      out.settingsSection = best.sectionId;
      return out;
    }
    const byKey = fieldByKey(args.settings_query.trim());
    if (byKey) {
      out.settingsSearchKey = byKey.key;
      out.settingsSection = byKey.area;
      return out;
    }
  }

  if (typeof args.settings_section === 'string' && args.settings_section.trim()) {
    const slug = args.settings_section.trim();
    out.settingsSection = slug;
    const area = slug as SettingsSectionId;
    if (categoryForArea(area)) {
      out.settingsSection = area;
    }
  }

  return out;
}

/** Launch a Minnow app and return JSON { ok, appId, hash }. */
export function toolLaunchMinnowApp(
  args: Record<string, unknown>,
  launchApp: (
    appId: AppId,
    options?: LaunchOptions,
  ) => void = defaultLaunchApp,
): string {
  const rawAppId = args[APP_ID_ARG];
  if (typeof rawAppId !== 'string' || !rawAppId.trim()) {
    return 'Error: "app_id" is required';
  }

  const appId = rawAppId.trim();
  const seed =
    typeof args.seed === 'string' && args.seed.trim() ? args.seed.trim() : undefined;

  if (appId === 'chat') {
    launchApp('code', {
      ...(seed ? { seed } : {}),
      codeSection: 'chat',
    });
    return JSON.stringify({
      ok: true,
      appId: 'code',
      hash: '#/app/code/chat',
      ...(seed ? { seed } : {}),
    });
  }

  if (!isAppId(appId)) {
    return `Error: invalid app_id "${appId}" (expected a Minnow app id)`;
  }

  if (!isAppAvailable(appId)) {
    const name = getAppById(appId)?.name ?? appId;
    return `Error: ${name} is not available`;
  }

  const options: LaunchOptions = {};
  if (seed) {
    options.seed = seed;
  }

  if (appId === 'settings') {
    Object.assign(options, resolveSettingsDeepLink(args));
    const brainSection = resolveBrainMemoryRoute(
      options.settingsSearchKey,
      options.settingsSection,
    );
    if (brainSection) {
      launchApp('brain', { brainSection });
      return JSON.stringify({
        ok: true,
        appId: 'brain',
        hash: `#/app/brain/${brainSection}`,
        ...(options.settingsSearchKey
          ? { settingsSearchKey: options.settingsSearchKey }
          : {}),
      });
    }
  }

  launchApp(appId, Object.keys(options).length > 0 ? options : undefined);

  const hash =
    appId === 'settings' && options.settingsSection
      ? `#/settings/${options.settingsSection}`
      : `#/app/${appId}`;
  return JSON.stringify({
    ok: true,
    appId,
    hash,
    ...(options.settingsSearchKey
      ? { settingsSearchKey: options.settingsSearchKey }
      : {}),
  });
}
