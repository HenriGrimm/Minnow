import {
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_AREAS,
  SETTINGS_CATEGORY_DESCRIPTIONS,
  SETTINGS_CATEGORY_LABELS,
  SETTINGS_FIELD_CATALOG,
  categoryForArea,
  fieldByKey,
  fieldsForArea,
  type SettingsCategoryId,
} from './settings-catalog';
import { isBoardTestingSettingsVisible } from '../config/dev-surfaces';

export type { SettingsCategoryId } from './settings-catalog';
export {
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_AREAS,
  SETTINGS_CATEGORY_DESCRIPTIONS,
  SETTINGS_CATEGORY_LABELS,
  SETTINGS_FIELD_CATALOG,
  categoryForArea,
  fieldByKey,
  fieldsForArea,
};

export type SettingsSectionId =
  | 'general'
  | 'notifications'
  | 'apps'
  | 'issues'
  | 'appearance'
  | 'audio'
  | 'providers'
  | 'usage'
  | 'model-routing'
  | 'sampler'
  | 'thinking'
  | 'agent-center'
  | 'injection'
  | 'prompting'
  | 'rules'
  | 'modes'
  | 'work-agents'
  | 'agent-packs'
  | 'sub-agents'
  | 'autopilot'
  | 'watchdog'
  | 'search'
  | 'deep-research'
  | 'servers'
  | 'tools'
  | 'browser'
  | 'mcp'
  | 'lsp'
  | 'editor'
  | 'skills'
  | 'skills-library'
  | 'webhooks'
  | 'voice'
  | 'diagnostics'
  | 'capability-matrix'
  | 'board-testing'
  | 'about';

/** Sidebar label (hash id stays stable for bookmarks). */
export const SETTINGS_SECTION_LABELS: Record<SettingsSectionId, string> = {
  general: 'General',
  notifications: 'Notifications',
  apps: 'Apps',
  issues: 'Issues',
  appearance: 'Appearance',
  audio: 'Audio',
  providers: 'Providers',
  usage: 'Usage & cost',
  'model-routing': 'Routing',
  sampler: 'Sampler',
  thinking: 'Thinking',
  'agent-center': 'Agents',
  injection: 'Injection',
  prompting: 'Prompts',
  rules: 'Rules',
  modes: 'Modes',
  'work-agents': 'Work agents',
  'agent-packs': 'Agent packs',
  'sub-agents': 'Sub-agents',
  autopilot: 'Autopilot',
  watchdog: 'Watchdog',
  search: 'Search',
  'deep-research': 'Deep Research',
  servers: 'Servers',
  tools: 'Tools',
  browser: 'Browser',
  mcp: 'MCP servers',
  lsp: 'Language servers',
  editor: 'Editor',
  skills: 'Skills',
  'skills-library': 'Skills Library',
  webhooks: 'Webhooks',
  voice: 'Voice',
  diagnostics: 'Health & diagnostics',
  'capability-matrix': 'Capability matrix',
  'board-testing': 'Board testing',
  about: 'About',
};

export type SettingsNavGroupId =
  | 'app'
  | 'apps'
  | 'agents'
  | 'integrations'
  | 'advanced';

export type SettingsNavGroup = {
  id: SettingsNavGroupId;
  label: string;
  sections: SettingsSectionId[];
};

/** Sidebar groups and nav order (must match index.html section order). */
export const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  { id: 'app', label: 'App', sections: ['general', 'notifications', 'appearance', 'audio', 'about'] },
  { id: 'apps', label: 'Apps', sections: ['apps', 'issues'] },
  {
    id: 'agents',
    label: 'Agents',
    sections: [
      'agent-center',
      'injection',
      'rules',
      'agent-packs',
      'autopilot',
      'watchdog',
    ],
  },
  {
    id: 'integrations',
    label: 'Tools & integrations',
    // 'deep-research' is omitted while the Research app is hidden: its config
    // has no other consumer, so the panel would configure nothing.
    sections: ['search', 'servers', 'tools', 'skills', 'skills-library', 'browser', 'mcp', 'lsp', 'editor', 'webhooks'],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    sections: [
      'diagnostics',
      'capability-matrix',
      ...(isBoardTestingSettingsVisible() ? (['board-testing'] as const) : []),
    ],
  },
];

/** Flat nav order for hash routing and panel wiring. */
export const SETTINGS_SECTIONS: SettingsSectionId[] =
  SETTINGS_NAV_GROUPS.flatMap((group) => group.sections);

/** Integrations hub groupings (one hub per integration area). */
export const SETTINGS_INTEGRATIONS_HUBS = [
  {
    id: 'web-research',
    label: 'Search',
    areas: ['search'],
  },
  {
    id: 'servers',
    label: 'Servers',
    areas: ['servers'],
  },
  {
    id: 'tools',
    label: 'Tools',
    areas: ['tools'],
  },
  {
    id: 'skills',
    label: 'Skills',
    areas: ['skills', 'skills-library'],
  },
  {
    id: 'browser',
    label: 'Browser',
    areas: ['browser'],
  },
  {
    id: 'mcp',
    label: 'MCP servers',
    areas: ['mcp'],
  },
  {
    id: 'lsp',
    label: 'Language servers',
    areas: ['lsp'],
  },
  {
    id: 'editor',
    label: 'Editor',
    areas: ['editor'],
  },
  {
    id: 'external',
    label: 'External',
    areas: ['webhooks'],
  },
] as const;

export type SettingsIntegrationsHubId =
  (typeof SETTINGS_INTEGRATIONS_HUBS)[number]['id'];

/** Map a legacy integration area slug to its hub id. */
export function hubForArea(area: SettingsSectionId): SettingsIntegrationsHubId | undefined {
  for (const hub of SETTINGS_INTEGRATIONS_HUBS) {
    if ((hub.areas as readonly SettingsSectionId[]).includes(area)) {
      return hub.id;
    }
  }
  return undefined;
}
