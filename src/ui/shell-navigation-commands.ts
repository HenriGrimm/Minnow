import type { AppDefinition } from '../os/app-registry';
import { listAvailableApps } from '../os/app-preferences';
import type { AppId, LaunchOptions } from '../os/types';
import {
  BUILTIN_VIEW_AGENTS,
  BUILTIN_VIEW_MY_OPEN,
  BUILTIN_VIEW_TRIAGE,
  SESSION_VIEW_ALL,
} from '../issues/saved-views';
import {
  BRAIN_MORE_SECTIONS,
  BRAIN_SECTION_LABELS,
  BRAIN_SECTIONS,
} from './brain-section-ids';
import type { Command } from './command-registry';
import {
  MODELS_SECTION_LABELS,
  MODELS_SECTIONS,
  type ModelsSectionId,
} from './models-section-ids';
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_SECTION_LABELS,
  type SettingsNavGroupId,
  type SettingsSectionId,
} from './settings-page-types';

export interface ShellNavigationDependencies {
  launchApp: (appId: AppId, options?: LaunchOptions) => void;
}

const MODELS_ADVANCED_SECTIONS = new Set<ModelsSectionId>([
  'engine',
  'settings',
  'clis',
  'sampler',
  'thinking',
  'voice',
  'usage',
]);

const SETTINGS_GROUP_KEYWORDS: Record<SettingsNavGroupId, string> = {
  app: 'app preferences desktop tray startup network filesystem notifications audio about version',
  apps: 'workspace plugins connections issues tracker github',
  agents: 'agents prompts modes rules memory injection workers packs autopilot watchdog',
  integrations: 'tools integrations search servers skills browser mcp lsp editor webhooks',
  advanced: 'advanced diagnostics health capability matrix testing',
};

const SETTINGS_SECTION_KEYWORDS: Partial<Record<SettingsSectionId, string>> = {
  general: 'desktop tray startup network lan filesystem terminal updates zoom gpu',
  notifications: 'alerts bell sound background jobs',
  plugins: 'packages extensions connections panels',
  issues: 'tracker taxonomy github sync workflow',
  appearance: 'theme font color accent density',
  audio: 'microphone speaker voice device',
  'agent-center': 'prompts modes work agents sub agents personas',
  injection: 'context memory prompt injection',
  rules: 'instructions standing rules knowledge',
  'agent-packs': 'personas agent pack import export',
  autopilot: 'orchestrate automation board defaults',
  watchdog: 'stalls retries recovery',
  search: 'web research searxng brave tavily',
  servers: 'local services runtime docker',
  tools: 'permissions security tool policy',
  skills: 'slash commands custom skills',
  'skills-library': 'packs install github curated',
  browser: 'automation chromium preview allowlist',
  mcp: 'model context protocol servers',
  'mcp-hub': 'external agents connect brain issues manual',
  lsp: 'language servers diagnostics',
  editor: 'copilot inline completion ghost text',
  webhooks: 'events hmac outgoing',
  diagnostics: 'health logs errors crash report',
  'capability-matrix': 'models benchmark probes verdicts',
  'board-testing': 'orchestrate fake model scenarios',
  about: 'build version electron node performance',
};

type IssuesDestination =
  | { id: 'list'; label: 'List'; options: LaunchOptions }
  | { id: 'board'; label: 'Board'; options: LaunchOptions }
  | { id: 'projects'; label: 'Projects'; options: LaunchOptions }
  | { id: 'all'; label: 'All issues'; options: LaunchOptions }
  | { id: 'triage'; label: 'Triage'; options: LaunchOptions }
  | { id: 'agents'; label: 'Assigned to agents'; options: LaunchOptions }
  | { id: 'mine'; label: 'My open'; options: LaunchOptions };

export const ISSUES_COMMAND_DESTINATIONS: readonly IssuesDestination[] = [
  { id: 'list', label: 'List', options: { issuesViewMode: 'list' } },
  { id: 'board', label: 'Board', options: { issuesViewMode: 'board' } },
  { id: 'projects', label: 'Projects', options: { issuesSection: 'projects' } },
  { id: 'all', label: 'All issues', options: { issuesSavedViewId: SESSION_VIEW_ALL } },
  { id: 'triage', label: 'Triage', options: { issuesSavedViewId: BUILTIN_VIEW_TRIAGE } },
  { id: 'agents', label: 'Assigned to agents', options: { issuesSavedViewId: BUILTIN_VIEW_AGENTS } },
  { id: 'mine', label: 'My open', options: { issuesSavedViewId: BUILTIN_VIEW_MY_OPEN } },
];

function appCommands(
  apps: readonly AppDefinition[],
  dependencies: ShellNavigationDependencies,
): Command[] {
  return apps.map((app) => ({
    id: `app.${app.id}`,
    title: `Go to ${app.name}`,
    group: 'Apps',
    keywords: `${app.name} ${app.id} ${app.tag} ${app.description} open switch navigate`,
    run: () => dependencies.launchApp(app.id),
  }));
}

function modelsCommands(dependencies: ShellNavigationDependencies): Command[] {
  return MODELS_SECTIONS.map((section) => {
    const advanced = MODELS_ADVANCED_SECTIONS.has(section);
    return {
      id: `navigate.models.${section}`,
      title: `Models: ${MODELS_SECTION_LABELS[section]}`,
      group: 'Navigate · Models',
      keywords: `models ${section} ${advanced ? 'advanced more ' : ''}local runtime provider connect run`,
      presentation: 'search-only' as const,
      run: () => dependencies.launchApp('models', { modelsSection: section }),
    };
  });
}

function brainCommands(dependencies: ShellNavigationDependencies): Command[] {
  return BRAIN_SECTIONS.map((section) => ({
    id: `navigate.brain.${section}`,
    title: `Brain: ${BRAIN_SECTION_LABELS[section]}`,
    group: 'Navigate · Brain',
    keywords: `brain wiki knowledge memory ${section} ${BRAIN_MORE_SECTIONS.has(section) ? 'more advanced' : ''}`,
    presentation: 'search-only' as const,
    run: () => dependencies.launchApp('brain', { brainSection: section }),
  }));
}

function issuesCommands(dependencies: ShellNavigationDependencies): Command[] {
  return ISSUES_COMMAND_DESTINATIONS.map((destination) => ({
    id: destination.id === 'list' || destination.id === 'board'
      ? `issues.view.${destination.id}`
      : destination.id === 'projects'
        ? 'navigate.issues.projects'
        : `issues.view.${destination.id}`,
    title: `Issues: ${destination.label}`,
    group: 'Navigate · Issues',
    keywords: `issues tracker ${destination.id} ${destination.label} view filter screen`,
    presentation: 'search-only' as const,
    run: () => dependencies.launchApp('issues', destination.options),
  }));
}

function settingsCommands(dependencies: ShellNavigationDependencies): Command[] {
  return SETTINGS_NAV_GROUPS.flatMap((navGroup) =>
    navGroup.sections.map((section) => ({
      id: `navigate.settings.${section}`,
      title: `Settings: ${SETTINGS_SECTION_LABELS[section]}`,
      group: 'Navigate · Settings',
      keywords: `settings preferences ${navGroup.label} ${SETTINGS_GROUP_KEYWORDS[navGroup.id]} ${SETTINGS_SECTION_KEYWORDS[section] ?? ''}`,
      presentation: 'search-only' as const,
      run: () => dependencies.launchApp('settings', { settingsSection: section }),
    })),
  );
}

/** Build the global navigation index from release-filtered app metadata. */
export function buildShellNavigationCommands(
  dependencies: ShellNavigationDependencies,
  apps: readonly AppDefinition[] = listAvailableApps(),
): Command[] {
  return [
    ...appCommands(apps, dependencies),
    ...modelsCommands(dependencies),
    ...brainCommands(dependencies),
    ...issuesCommands(dependencies),
    ...settingsCommands(dependencies),
  ];
}
