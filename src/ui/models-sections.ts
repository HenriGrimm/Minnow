import type { ModelsSectionId } from './models-section-ids';
import { mountDiscoverSection } from './models/discover-panel';
import { mountLibrarySection } from './models/library-panel';
import { mountModelsSettingsSection } from './models/models-settings-panel';
import { mountEngineSection } from './models/engine-panel';
import { mountServerSection } from './models/server-panel';
import { reparentSettingsSectionIntoModels } from './models/settings-reparent';
import { mountVoicePanel } from './models/voice-panel';
import { setModelsRailCount, usesGraphiteModels } from './models/graphite-chrome';
import { mountGraphiteSamplerControls } from './models/graphite-sampler';
import { el } from './models/dom';

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
  if ((section === 'sampler' || section === 'thinking') && usesGraphiteModels()) {
    const host = document.getElementById('modelsSection-sampler');
    if (!host) return;
    let grid = host.querySelector<HTMLElement>('.models-tune-grid');
    if (!grid) {
      const heading = el('header', 'models-graphite-section-heading');
      heading.append(el('h2', undefined, 'Sampling and thinking'), el('p', undefined, 'Defaults for every model. Per-model presets override them.'));
      grid = el('div', 'models-tune-grid');
      host.prepend(heading, grid);
    }
    await Promise.all([
      reparentSettingsSectionIntoModels('sampler', 'sampler', grid),
      reparentSettingsSectionIntoModels('thinking', 'thinking', grid),
    ]);
    mountGraphiteSamplerControls(grid);
    return;
  }
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
        if (section === 'providers' && usesGraphiteModels()) {
          const host = document.getElementById('modelsSection-providers');
          const toolbar = host?.querySelector('.settings-providers-toolbar');
          if (toolbar && !toolbar.querySelector('.models-providers-heading')) {
            toolbar.prepend(el('h2', 'models-providers-heading', 'Providers'));
          }
          setModelsRailCount('providers', host?.querySelectorAll('.settings-providers-row').length ?? 0);
        }
      }
      break;
    }
  }
}
