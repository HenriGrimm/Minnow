import type { SettingsSectionId } from './settings-page-types';

export type SettingsSearchEntryKind =
  | 'section'
  | 'nav-group'
  | 'mode'
  | 'expert'
  | 'work-agent'
  | 'sub-agent'
  | 'models-section'
  | 'brain-section'
  | 'field'
  | 'category';

/** One searchable destination in the settings page. */
export type SettingsSearchEntry = {
  /** Stable id for list keys (not always equal to searchKey). */
  id: string;
  label: string;
  sectionId: SettingsSectionId;
  kind: SettingsSearchEntryKind;
  /** When set, open Models app instead of settings (e.g. voice I/O). */
  modelsSection?: string;
  /** When set, open Brain app instead of settings (e.g. memory store). */
  brainSection?: string;
  /** DOM anchor via data-settings-search-key after navigation. */
  searchKey?: string;
  keywords?: string[];
  /** Secondary line in the finder dropdown. */
  hint?: string;
};
