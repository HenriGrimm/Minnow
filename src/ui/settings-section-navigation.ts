import type { SettingsSectionId } from './settings-page-types';

/** Resolved target for opening or scrolling to a settings area. */
export type SettingsSectionNavigation = {
  sectionId: SettingsSectionId;
  searchKey?: string;
};

/**
 * Legacy area slugs merged into Agents (agent-center). Hash bookmarks and
 * cross-links may still use the old ids.
 */
const LEGACY_SECTION_ALIASES: Partial<Record<SettingsSectionId, SettingsSectionId>> = {
  prompting: 'agent-center',
  modes: 'agent-center',
  'work-agents': 'agent-center',
  'sub-agents': 'agent-center',
};

/** Default search anchors when landing on agent-center from a legacy slug. */
const LEGACY_SECTION_SEARCH_KEYS: Partial<Record<SettingsSectionId, string>> = {
  modes: 'modes.plan',
  'sub-agents': 'agents.subAgents',
  'work-agents': 'agents.workAgents',
};

/** Map legacy or reparented section slugs to a visible panel + optional scroll target. */
export function resolveSettingsSectionNavigation(
  sectionId: SettingsSectionId,
  searchKey?: string,
): SettingsSectionNavigation {
  const resolvedId = LEGACY_SECTION_ALIASES[sectionId] ?? sectionId;
  return {
    sectionId: resolvedId,
    searchKey: searchKey ?? LEGACY_SECTION_SEARCH_KEYS[sectionId],
  };
}
