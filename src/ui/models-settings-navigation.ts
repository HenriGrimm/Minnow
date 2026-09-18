import type { ModelsSectionId } from './models-section-ids';
/** Settings render mounts that are owned and displayed by the Models app. */
const MODELS_SECTION_BY_SETTINGS_AREA: Partial<
  Record<string, ModelsSectionId>
> = {
  providers: 'providers',
  'model-routing': 'routing',
  sampler: 'sampler',
  thinking: 'thinking',
  usage: 'usage',
  voice: 'voice',
  engine: 'engine',
};

export function modelsSectionForSettingsArea(
  area: string,
): ModelsSectionId | undefined {
  return MODELS_SECTION_BY_SETTINGS_AREA[area];
}
