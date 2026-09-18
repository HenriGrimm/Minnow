import type { ModelsSectionId } from './models-section-ids';
import { mountDiscoverSection } from './models/discover-panel';
import { mountLibrarySection } from './models/library-panel';
import { mountModelsSettingsSection } from './models/models-settings-panel';
import { mountEngineSection } from './models/engine-panel';
import { mountServerSection } from './models/server-panel';
import { reparentSettingsSectionIntoModels } from './models/settings-reparent';
import { mountVoicePanel } from './models/voice-panel';

/** Map Models routing section ids to legacy settings section ids. */
const SETTINGS_SECTION_BY_MODELS: Partial<
  Record<ModelsSectionId, import('./settings-page-types').SettingsSectionId>
> = {
  providers: 'providers',
  routing: 'model-routing',
  sampler: 'sampler',
  thinking: 'thinking',
  usage: 'usage',
};

/** Render a Models section on first activation. */
export async function renderModelsSection(section: ModelsSectionId): Promise<void> {
  switch (section) {
    case 'clis':
      await (await import('./models/cli-panel')).mountCliPanel();
      break;
    case 'routers':
      await (await import('./models/routers-panel')).mountRoutersPanel();
      break;
    case 'installed':
      mountLibrarySection();
      break;
    case 'recommend':
      mountDiscoverSection();
      break;
    case 'server':
      mountServerSection();
      break;
    case 'engine':
      await mountEngineSection();
      break;
    case 'settings':
      await mountModelsSettingsSection();
      break;
    case 'voice':
      await reparentSettingsSectionIntoModels('voice', 'voice');
      mountVoicePanel();
      break;
    default: {
      const settingsId = SETTINGS_SECTION_BY_MODELS[section];
      if (settingsId) {
        await reparentSettingsSectionIntoModels(section, settingsId);
      }
      break;
    }
  }
}
