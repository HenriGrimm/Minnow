import { refreshSettingsSection } from '../settings-sections';
import { categoryForArea } from '../settings-page-types';
import type { SettingsSectionId } from '../settings-page-types';
import type { ModelsSectionId } from '../models-page';

const SETTINGS_CONTENT_SELECTOR = '.settings-content';

/** Track which settings sections were moved into Models panels. */
const reparented = new Map<ModelsSectionId, HTMLElement>();

/** Move settings section markup into the Models panel mount. */
export async function reparentSettingsSectionIntoModels(
  modelsSection: ModelsSectionId,
  settingsSection: SettingsSectionId,
  target?: HTMLElement,
): Promise<void> {
  const mount = target ?? document.getElementById(`modelsSection-${modelsSection}`);
  const settingsSectionEl = document.getElementById(`settingsSection-${settingsSection}`);
  const settingsContent = document.querySelector(SETTINGS_CONTENT_SELECTOR);
  if (!mount || !settingsSectionEl || !settingsContent) return;

  if (settingsSectionEl.parentElement !== mount) {
    reparented.set(modelsSection, settingsSectionEl);
    mount.appendChild(settingsSectionEl);
    settingsSectionEl.classList.add('is-active');
  }

  await refreshSettingsSection(settingsSection);
}

/** Restore reparented settings sections when Models app closes (optional cleanup). */
export function restoreReparentedSettingsSections(): void {
  for (const [, el] of reparented) {
    const area = el.dataset.area as SettingsSectionId | undefined;
    const categoryPanel = area
      ? document.querySelector(
          `.settings-category[data-category="${categoryForArea(area)}"]`,
        )
      : document.querySelector(SETTINGS_CONTENT_SELECTOR);
    (categoryPanel ?? document.querySelector(SETTINGS_CONTENT_SELECTOR))?.appendChild(el);
    el.classList.remove('is-active');
  }
  reparented.clear();
}
