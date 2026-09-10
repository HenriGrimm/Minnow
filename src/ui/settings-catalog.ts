import { isBoardTestingSettingsVisible } from '../config/dev-surfaces';
import type { SettingsSectionId } from './settings-page-types';
import { filterSettingsCatalogEntries } from './settings-catalog-filter';

/** Top-level sidebar categories. */
export type SettingsCategoryId =
  | 'general'
  | 'apps'
  | 'appearance'
  | 'models'
  | 'agents'
  | 'integrations'
  | 'advanced';

export interface SettingsFieldEntry {
  /** Canonical DOM anchor via data-settings-search-key. */
  key: string;
  label: string;
  category: SettingsCategoryId;
  /** Existing render unit / legacy hash slug. */
  area: SettingsSectionId;
  keywords?: string[];
  description?: string;
}

/** Sidebar labels for settings categories. */
export const SETTINGS_CATEGORY_LABELS: Record<SettingsCategoryId, string> = {
  general: 'General',
  apps: 'Apps',
  appearance: 'Appearance',
  models: 'Models',
  agents: 'Agents',
  integrations: 'Integrations',
  advanced: 'Advanced',
};

/** Category descriptions (search keywords / future catalog hints; not shown in UI). */
export const SETTINGS_CATEGORY_DESCRIPTIONS: Record<SettingsCategoryId, string> = {
  general: 'Terminal behavior, filesystem and LAN access, notifications, audio devices, and where settings are saved.',
  apps: 'Choose which Minnow apps appear in the dock and launchers.',
  appearance: 'Theme, fonts, and custom accent colors.',
  models: 'LLM backends, per-role model picks, sampling, reasoning, and usage.',
  agents: 'System prompts, standing rules, composer modes, personas, workers, and tool policies.',
  integrations: 'Web search, dev tools, permissions, skills, and external hooks.',
  advanced: 'Local health probes, capability matrix, and diagnostics.',
};

/** Category → ordered areas (render units). */
export const SETTINGS_CATEGORY_AREAS: Record<
  SettingsCategoryId,
  SettingsSectionId[]
> = {
  general: ['general', 'notifications', 'audio', 'about'],
  apps: ['apps', 'issues'],
  appearance: ['appearance'],
  models: ['providers', 'model-routing', 'sampler', 'thinking', 'usage'],
  agents: ['agent-center', 'injection', 'rules', 'agent-packs', 'autopilot', 'watchdog'],
  integrations: [
    'search',
    'deep-research',
    'servers',
    'tools',
    'skills',
    'skills-library',
    'browser',
    'mcp',
    'lsp',
    'editor',
    'webhooks',
  ],
  advanced: [
    'diagnostics',
    'capability-matrix',
    ...(isBoardTestingSettingsVisible() ? (['board-testing'] as const) : []),
  ],
};

/** Flat category list in sidebar order. */
export const SETTINGS_CATEGORIES: SettingsCategoryId[] = [
  'general',
  'apps',
  'appearance',
  'models',
  'agents',
  'integrations',
  'advanced',
];

/** Areas reparented into Models without appearing in Settings sub-nav. */
const SETTINGS_AREA_CATEGORY_OVERRIDES: Partial<
  Record<SettingsSectionId, SettingsCategoryId>
> = {
  voice: 'models',
};

/** Map legacy area slug → parent category. */
export function categoryForArea(area: SettingsSectionId): SettingsCategoryId {
  const override = SETTINGS_AREA_CATEGORY_OVERRIDES[area];
  if (override) return override;
  for (const category of SETTINGS_CATEGORIES) {
    if (SETTINGS_CATEGORY_AREAS[category].includes(area)) {
      return category;
    }
  }
  return 'general';
}

/** Catalog entries belonging to one area. */
export function fieldsForArea(area: SettingsSectionId): SettingsFieldEntry[] {
  return SETTINGS_FIELD_CATALOG.filter((entry) => entry.area === area);
}

/** Lookup a catalog entry by canonical key. */
export function fieldByKey(key: string): SettingsFieldEntry | undefined {
  return SETTINGS_FIELD_CATALOG.find((entry) => entry.key === key);
}

/** Categories that show a sticky in-panel area sub-nav. */
export const SETTINGS_CATEGORY_SUBNAV: ReadonlySet<SettingsCategoryId> = new Set([
  'general',
  'models',
  'agents',
  'integrations',
  'advanced',
]);

function field(
  key: string,
  label: string,
  category: SettingsCategoryId,
  area: SettingsSectionId,
  extras?: Pick<SettingsFieldEntry, 'keywords' | 'description'>,
): SettingsFieldEntry {
  return { key, label, category, area, ...extras };
}

/** Static field catalog source — filtered for release gates in SETTINGS_FIELD_CATALOG. */
const SETTINGS_FIELD_CATALOG_ALL: SettingsFieldEntry[] = [
  field('general.updates', 'App updates', 'general', 'general', {
    keywords: ['update', 'version', 'upgrade', 'beta', 'release', 'restart', 'auto-update'],
    description: 'Stay on the latest build. Downloads run in the background; restart when you are ready.',
  }),
  field('general.updates.channel', 'Update channel', 'general', 'general', {
    keywords: ['beta', 'stable', 'prerelease', 'channel'],
    description: 'Choose Stable releases or Beta pre-releases for auto-update.',
  }),
  field('general.desktop', 'Desktop app', 'general', 'general', {
    keywords: ['tray', 'close', 'startup', 'background', 'minimize'],
    description: 'System tray behavior and whether Minnow opens when you sign in.',
  }),
  field('general.desktop.closeToTray', 'Keep Minnow running after closing the window', 'general', 'general', {
    keywords: ['tray', 'background', 'close', 'hide'],
  }),
  field(
    'general.desktop.windowCloseAction',
    'Closing one of several windows',
    'general',
    'general',
    {
      keywords: ['workspace', 'window', 'close', 'background', 'tray', 'multi-window'],
      description:
        'Whether closing one of several windows closes that workspace or leaves it running in the tray.',
    },
  ),
  field('general.desktop.zoom', 'Interface zoom', 'general', 'general', {
    keywords: ['zoom', 'scale', 'size', 'magnify', 'desktop', 'ui'],
    description: 'Scale the Minnow desktop window (Electron shell only).',
  }),
  field('general.desktop.launchAtStartup', 'Launch Minnow at startup', 'general', 'general', {
    keywords: ['login', 'boot', 'startup', 'open at login'],
  }),
  field('general.desktop.hardwareAcceleration', 'Hardware acceleration', 'general', 'general', {
    keywords: ['gpu', 'acceleration', 'performance', 'render', 'graphics'],
    description:
      'Render the interface on the GPU. Turning it off frees the GPU for local models. Applies after a restart.',
  }),
  field('general.notifications', 'Notifications', 'general', 'notifications', {
    keywords: ['bell', 'alert', 'sound', 'menubar'],
    description: 'Menubar bell when background chats, tasks, or jobs need attention.',
  }),
  field('general.notifications.enabled', 'Enable notifications', 'general', 'notifications', {
    keywords: ['master toggle', 'bell'],
  }),
  field('general.notifications.chat', 'Chat notifications', 'general', 'notifications'),
  field('general.notifications.tasks', 'Task notifications', 'general', 'notifications', {
    keywords: ['orchestrate', 'sub-agent'],
  }),
  field('general.notifications.background', 'Background job notifications', 'general', 'notifications', {
    keywords: ['scheduler', 'research', 'synthesis'],
  }),
  field('general.notifications.sound', 'Notification sounds', 'general', 'notifications'),
  field('general.notifications.soundOnActiveChat', 'Sounds in active chat', 'general', 'notifications'),
  field('general.network', 'Network access', 'general', 'general', {
    keywords: ['lan', 'wifi', 'local network', 'remote', 'phone', 'tablet', '0.0.0.0'],
    description: 'Let other devices on your Wi-Fi open Minnow in a browser while this PC runs the app.',
  }),
  field('general.filesystem', 'Filesystem access', 'general', 'general', {
    keywords: ['workspace', 'full disk', 'path', 'sandbox', 'file tools', 'git'],
    description: 'Limit file and git tools to the open project folder, or allow paths anywhere on this computer.',
  }),
  field('general.shellSandbox', 'Agent shell sandbox', 'general', 'general', {
    keywords: ['sandbox', 'shell', 'seatbelt', 'landlock', 'execute_command', 'containment'],
    description: 'Contain agent one-shot shells with OS filesystem sandboxing.',
  }),
  field('general.onboarding', 'Run setup again', 'general', 'general', {
    keywords: ['wizard', 'onboarding', 'first run', 'setup'],
    description: 'Re-open the first-run setup wizard.',
  }),
  field('general.chat.terminal', 'Terminal behavior', 'general', 'general', {
    keywords: ['shell', 'background command'],
  }),
  field('general.toolCalls.constrained', 'Constrained tool calls', 'general', 'general', {
    keywords: ['json schema', 'structured output'],
    description: 'Validate tool arguments with JSON Schema when the provider supports structured output.',
  }),
  field('audio.devices', 'Audio devices', 'general', 'audio', {
    keywords: ['microphone', 'speaker', 'input', 'output'],
  }),
  field('audio.inputDevice', 'Input device', 'general', 'audio', {
    keywords: ['microphone', 'mic'],
  }),
  field('audio.outputDevice', 'Output device', 'general', 'audio', {
    keywords: ['speaker', 'sink'],
  }),
  field('audio.echoCancellation', 'Echo cancellation', 'general', 'audio'),
  field('audio.noiseSuppression', 'Noise suppression', 'general', 'audio'),
  field('audio.autoGainControl', 'Auto gain control', 'general', 'audio'),

  field('apps.visibility', 'App visibility', 'apps', 'apps', {
    keywords: ['dock', 'launcher', 'enable', 'disable', 'hide apps', 'optional apps', 'enable all'],
    description: 'Hide optional apps from the dock and launchers.',
  }),
  field('apps.core.chat', 'Chat app', 'apps', 'apps', {
    keywords: ['always on', 'core'],
  }),
  field('apps.core.models', 'Models app', 'apps', 'apps', {
    keywords: ['always on', 'core'],
  }),
  field('apps.core.brain', 'Brain app', 'apps', 'apps', {
    keywords: ['always on', 'core'],
  }),
  field('apps.core.settings', 'Settings app', 'apps', 'apps', {
    keywords: ['always on', 'core'],
  }),
  field('apps.core.code', 'Code app', 'apps', 'apps', {
    keywords: ['always on', 'core'],
  }),
  field('apps.core.research', 'Research app', 'apps', 'apps', {
    keywords: ['always on', 'core'],
  }),
  field('apps.core.scheduler', 'Scheduler app', 'apps', 'apps', {
    keywords: ['always on', 'core'],
  }),
  field('apps.optional.code', 'Code app', 'apps', 'apps'),
  field('apps.optional.experts', 'Experts app', 'apps', 'apps'),
  field('apps.optional.bench', 'Benchmarking app', 'apps', 'apps', {
    keywords: ['bench', 'benchmark'],
  }),
  field('apps.optional.compare', 'Compare app', 'apps', 'apps'),
  field('apps.optional.email', 'Email app', 'apps', 'apps'),
  field('apps.issues.types', 'Issue types', 'apps', 'issues', {
    keywords: ['issue types', 'bug', 'task', 'idea', 'feature', 'improvement', 'taxonomy', 'color'],
    description: 'Customize issue type labels, ids, icons, and colors.',
  }),
  field('apps.issues.statuses', 'Issue statuses', 'apps', 'issues', {
    keywords: ['issue statuses', 'workflow', 'board columns', 'triage', 'review'],
    description: 'Workflow statuses, board columns, and semantic roles.',
  }),
  field('apps.issues.priorities', 'Issue priorities', 'apps', 'issues', {
    keywords: ['priorities', 'urgent', 'severity'],
    description: 'Priority levels for issues.',
  }),

  field('appearance.theme', 'Theme presets', 'appearance', 'appearance', {
    keywords: ['color', 'dark', 'light', 'swamp', 'desert', 'ocean', 'coral', 'mono', 'matrix', 'human', 'mint', 'palette'],
  }),
  field('appearance.theme.family', 'Theme family', 'appearance', 'appearance'),
  field('appearance.theme.mode', 'Theme mode', 'appearance', 'appearance', {
    keywords: ['dark mode', 'light mode', 'follow system'],
  }),
  field('appearance.fonts', 'Fonts', 'appearance', 'appearance', {
    keywords: ['typography', 'mono', 'ui font'],
  }),
  field('appearance.customColors', 'Custom colors', 'appearance', 'appearance', {
    keywords: ['tokens', 'override'],
  }),

  field('models.providers', 'Providers', 'models', 'providers', {
    keywords: ['api', 'lm studio', 'openai', 'backend'],
  }),
  field('models.providers.add', 'Add provider', 'models', 'providers'),
  field('models.routing', 'Model routing', 'models', 'model-routing', {
    keywords: ['bindings', 'roles', 'default model', 'goal evaluator', 'goal-eval'],
  }),
  field('models.routing.goalEval', 'Goal evaluator', 'models', 'model-routing', {
    keywords: ['goal', '/goal', 'evaluator', 'completion judge'],
    description: 'Model for /goal loop evaluation after each turn.',
  }),
  field('models.routing.utilityTasks', 'Utility tasks', 'models', 'model-routing', {
    keywords: ['title', 'expand', 'composer', 'issue', 'git commit', 'sparkles'],
    description: 'One model for chat titles, prompt and issue expansion, and commit messages.',
  }),
  field('models.sampler', 'Sampler defaults', 'models', 'sampler', {
    keywords: ['temperature', 'top p', 'penalties'],
  }),
  field('models.sampler.temperature', 'Temperature', 'models', 'sampler'),
  field('models.sampler.topP', 'Top P', 'models', 'sampler'),
  field('models.sampler.topK', 'Top K', 'models', 'sampler'),
  field('models.sampler.minP', 'Min P', 'models', 'sampler'),
  field('models.sampler.repetitionPenalty', 'Repeat penalty', 'models', 'sampler'),
  field('models.sampler.presencePenalty', 'Presence penalty', 'models', 'sampler'),
  field('models.sampler.maxTokens', 'Max tokens', 'models', 'sampler'),
  field('models.thinking', 'Thinking defaults', 'models', 'thinking', {
    keywords: ['reasoning', 'chain of thought'],
  }),
  field('models.thinking.mode', 'Default thinking', 'models', 'thinking'),
  field('models.thinking.budget', 'Thinking budget', 'models', 'thinking', {
    keywords: ['reasoning tokens', 'cot budget'],
  }),
  field('models.usage', 'Usage & cost', 'models', 'usage', {
    keywords: ['tokens', 'billing', 'inference'],
  }),
  field('models.usage.pricing', 'Model pricing', 'models', 'usage', {
    keywords: ['usd', 'per million', 'rates'],
  }),
  field('models.usage.active', 'Active chat usage', 'models', 'usage'),
  field('models.usage.session', 'Workspace session usage', 'models', 'usage'),

  field('agents.center', 'Agents center', 'agents', 'agent-center', {
    keywords: ['modes', 'work agents', 'sub-agents', 'prompts', 'routing'],
  }),
  field('agents.modes', 'Composer modes', 'agents', 'agent-center'),
  field('agents.modes.superPlan', 'Super Plan pipeline', 'agents', 'agent-center', {
    keywords: ['super plan', 'grill', 'review rounds', 'impeccable', 'research scope'],
    description:
      'Review rounds, grill budget, research scope/rounds/depth, Impeccable toggle, per-stage models.',
  }),
  field('agents.modes.planGranularity', 'Plan granularity', 'agents', 'agent-center', {
    keywords: ['large', 'medium', 'small', 'planner tasks'],
  }),
  field('agents.experts', 'Experts', 'agents', 'agent-center', {
    keywords: ['persona', 'specialist', 'expert lab'],
  }),
  field('agents.workAgents', 'Work agents', 'agents', 'agent-center'),
  field('agents.agentPacks', 'Agent packs', 'agents', 'agent-packs', {
    keywords: ['template', 'download', 'default pack', 'builtin', 'manifest', 'work agent'],
  }),
  field('agents.subAgents', 'Sub-agents', 'agents', 'agent-center', {
    keywords: ['spawn', 'subagent'],
  }),
  field('agents.autopilot', 'Orchestrator autopilot', 'agents', 'autopilot', {
    keywords: ['orchestrate', 'board', 'autopilot', 'concurrency', 'isolation'],
    description: 'Global defaults for orchestrate board concurrency, planner model, and retries.',
  }),
  field('agents.autopilot.defaultStatus', 'New boards start', 'agents', 'autopilot', {
    keywords: ['running', 'stopped', 'start', 'unattended'],
  }),
  field('agents.autopilot.isolation', 'Default isolation mode', 'agents', 'autopilot'),
  field('agents.autopilot.concurrency', 'Max concurrent tasks', 'agents', 'autopilot'),
  field('agents.autopilot.plannerModel', 'Default planner model', 'agents', 'autopilot'),
  field('agents.watchdog', 'Watchdog', 'agents', 'watchdog', {
    keywords: ['timeout', 'generation', 'streaming', 'idle'],
    description:
      'Idle and max-duration limits while streaming from the model. Sub-agent wall-clock lives under Sub-agents.',
  }),
  field('agents.watchdog.generation', 'Generation timeouts', 'agents', 'watchdog', {
    keywords: ['idle timeout', 'max duration', 'streaming', 'upstream'],
    description:
      'Idle and max-duration limits while streaming from the model. Idle timeout resets when new tokens arrive.',
  }),
  field('agents.watchdog.supervision', 'Sub-agent recovery', 'agents', 'watchdog', {
    keywords: ['sub-agent', 'timeout', 'crash', 'retry', 'reconcile', 'journal'],
    description:
      'Crashed or timed-out sub-agents retry from the journal. Wall-clock budget is Sub-agents default/per-type timeout.',
  }),
  field('agents.autopilot.selfHeal', 'Self-heal & provisioning', 'agents', 'autopilot', {
    keywords: ['self-heal', 'provision', 'quarantine', 'infra', 'worktree', 'stall'],
    description: 'Configure self-heal rounds, infra provisioning, and worktree cd-guard.',
  }),
  field('agents.autopilot.selfHealMaxRounds', 'Max self-heal rounds', 'agents', 'autopilot', {
    keywords: ['self-heal', 'rounds', 'quarantine'],
  }),
  field('agents.autopilot.infraProvisionTimeout', 'Infra provision timeout', 'agents', 'autopilot', {
    keywords: ['infra', 'provision', 'timeout'],
  }),
  field('agents.autopilot.autoProvisionInfra', 'Auto-provision infra', 'agents', 'autopilot', {
    keywords: ['provision', 'infra', 'docker'],
  }),
  field('agents.autopilot.afkAutoRestartStalls', 'Auto-restart stalled tasks', 'agents', 'autopilot', {
    keywords: ['stall', 'restart', 'quarantine', 'afk'],
  }),
  field('agents.autopilot.guardCdOutsideWorktree', 'Guard cd outside worktree', 'agents', 'autopilot', {
    keywords: ['worktree', 'cd', 'guard', 'isolation'],
  }),
  field('agents.prompting', 'Prompt profiles', 'agents', 'agent-center', {
    keywords: ['prompt', 'system prompt', 'full', 'lite', 'custom'],
  }),
  field('agents.prompting.profiles', 'Setup profiles', 'agents', 'agent-center', {
    keywords: ['bundle', 'export', 'import'],
  }),
  field('agents.prompting.hub', 'Agent cards', 'agents', 'agent-center'),
  field('agents.injection', 'Injection', 'agents', 'injection', {
    keywords: ['context', 'brain notes', 'code map', 'prompt context', 'composer'],
  }),
  field('agents.injection.brainNotes', 'Inject Brain notes by default', 'agents', 'injection', {
    keywords: ['memory injection', 'brain notes', 'memories', 'recall'],
  }),
  field('agents.injection.codeMap', 'Inject code map by default', 'agents', 'injection', {
    keywords: ['code map injection', 'repo map injection', 'code map default'],
  }),
  field('agents.rules', 'User rules', 'agents', 'rules', {
    keywords: ['cursor rules', 'instructions'],
  }),
  field('agents.rules.enabled', 'Enable user rules', 'agents', 'rules'),
  field('agents.rules.items', 'Rule list', 'agents', 'rules', {
    keywords: ['cursor rules', 'instructions', 'groups'],
  }),
  field('agents.rules.addGroup', 'Add rule group', 'agents', 'rules'),
  field('agents.rules.deleteGroup', 'Delete rule group', 'agents', 'rules', {
    keywords: ['remove group'],
  }),
  field('agents.injection.contextDocuments', 'Workspace context documents', 'agents', 'injection', {
    keywords: ['agents.md', 'context.md', 'cursor rules', 'injection', 'workspace'],
  }),
  field('agents.injection.contextDocuments.default', 'Inject context documents by default', 'agents', 'injection'),
  field('agents.injection.contextDocuments.presets', 'Context document presets', 'agents', 'injection'),
  field('agents.injection.contextDocuments.custom', 'Custom context document paths', 'agents', 'injection'),
  field('agents.rules.reasoningReplay', 'Prior reasoning replay', 'agents', 'rules', {
    keywords: ['thinking', 'reasoning', 'chain of thought', 'replay', 'context'],
  }),
  field('agents.rules.reasoningReplay.enabled', 'Replay prior reasoning', 'agents', 'rules', {
    keywords: ['thinking', 'reasoning', 'replay'],
  }),

  field('integrations.search', 'Web search provider', 'integrations', 'search', {
    keywords: ['brave', 'tavily', 'duckduckgo', 'searxng', 'web research'],
  }),
  field('integrations.search.provider', 'Search provider', 'integrations', 'search'),
  field('integrations.search.apiKeys', 'Search API keys', 'integrations', 'search'),
  field('integrations.deepResearch', 'Deep Research', 'integrations', 'deep-research', {
    keywords: ['research engine', 'iterresearch'],
  }),
  field('integrations.deepResearch.model', 'Research model', 'integrations', 'deep-research'),
  field('integrations.deepResearch.searchOverride', 'Research search override', 'integrations', 'deep-research'),
  field('integrations.deepResearch.loop', 'Research loop limits', 'integrations', 'deep-research'),
  field('integrations.deepResearch.extraction', 'Research extraction', 'integrations', 'deep-research'),
  field('integrations.deepResearch.report', 'Research final report', 'integrations', 'deep-research'),
  field('integrations.deepResearch.save', 'Save Deep Research settings', 'integrations', 'deep-research'),
  field('integrations.servers', 'Managed servers', 'integrations', 'servers', {
    keywords: ['searxng', 'local search'],
  }),
  field('integrations.tools', 'Tool permissions', 'integrations', 'tools', {
    keywords: ['allow', 'deny', 'security'],
  }),
  field('integrations.tools.cache', 'Tool result cache', 'integrations', 'tools'),
  field('integrations.tools.lazyLoading', 'Load tool schemas on demand', 'integrations', 'tools', {
    keywords: ['lazy', 'context', 'search_tools', 'schemas'],
  }),
  field('integrations.tools.outputCap', 'Limit tool result size', 'integrations', 'tools', {
    keywords: ['truncation', 'output cap', '32k', 'full_result', 'tool result'],
    description:
      'Caps how much text each file read, search, or shell command returns to the model. This does not compress chat history.',
  }),
  field('integrations.tools.outputCap.maxChars', 'Maximum characters per tool result', 'integrations', 'tools', {
    keywords: ['truncation', 'max chars', 'output cap'],
  }),
  field('integrations.tools.bulk', 'Bulk tool permissions', 'integrations', 'tools', {
    keywords: ['reset defaults', 'all full permissions'],
  }),
  field('integrations.mcp', 'MCP servers', 'integrations', 'mcp', {
    keywords: ['model context protocol', 'context7'],
  }),
  field('integrations.lsp', 'Language servers', 'integrations', 'lsp', {
    keywords: ['diagnostics', 'typescript', 'lsp.json'],
  }),
  field('integrations.editor', 'Editor copilot', 'integrations', 'editor', {
    keywords: ['ghost text', 'inline completion', 'codemirror'],
  }),
  field('integrations.skills', 'Skills', 'integrations', 'skills', {
    keywords: ['slash command', 'skill pack'],
  }),
  field('integrations.skills-library', 'Skills Library', 'integrations', 'skills-library', {
    keywords: ['curated packs', 'matt pocock', 'install skill', 'github url', 'browse skills'],
    description: 'Browse curated third-party skill packs, install from GitHub, and manage provenance.',
  }),
  field('integrations.webhooks', 'Webhooks', 'integrations', 'webhooks', {
    keywords: ['hmac', 'outgoing events'],
  }),
  field('integrations.browser', 'Browser automation', 'integrations', 'browser', {
    keywords: ['cdp', 'automation', 'allowlist', 'preview'],
  }),
  field('integrations.browser.allowNavigate', 'Allow browser navigation', 'integrations', 'browser'),
  field('integrations.browser.restoreTabs', 'Restore browser tabs', 'integrations', 'browser'),
  field('integrations.browser.patterns', 'Allowed origin patterns', 'integrations', 'browser'),
  field('integrations.browser.devtoolsDock', 'DevTools dock', 'integrations', 'browser'),

  field('advanced.diagnostics', 'Health & diagnostics', 'advanced', 'diagnostics', {
    keywords: ['errors', 'logs', 'crash', 'report', 'health strip', 'subsystem'],
    description: 'Subsystem probes, grouped errors, and a local log tail. Nothing is sent off-device.',
  }),
  field('advanced.diagnostics.health', 'Health probes', 'advanced', 'diagnostics', {
    keywords: ['server', 'memory', 'brain', 'lsp', 'pty', 'status strip'],
  }),
  field('advanced.diagnostics.actions', 'Diagnostic actions', 'advanced', 'diagnostics', {
    keywords: ['copy report', 'refresh', 'clear logs'],
  }),
  field(
    'advanced.diagnostics.fileErrorsToIssues',
    'File renderer errors to Issues',
    'advanced',
    'diagnostics',
    {
      keywords: ['issues', 'bug', 'crash', 'auto-file', 'tracker', 'renderer'],
      description:
        'When enabled, uncaught renderer errors create bug cards in the Issues app (off by default).',
    },
  ),

  field('advanced.capabilityMatrix', 'Capability matrix', 'advanced', 'capability-matrix', {
    keywords: ['benchmark', 'capabilities', 'spreadsheet', 'model matrix', 'roster'],
    description:
      '59-capability grid with manual verdicts, auto probe results, and run history.',
  }),
  field('advanced.capabilityMatrix.roster', 'Matrix roster', 'advanced', 'capability-matrix', {
    keywords: ['models', 'cloud', 'lm studio', 'hosting'],
  }),
  field('advanced.capabilityMatrix.grid', 'Capability grid', 'advanced', 'capability-matrix', {
    keywords: ['verdict', 'pass', 'fail', 'manual', 'auto'],
  }),
  field('advanced.capabilityMatrix.run', 'Run capability matrix', 'advanced', 'capability-matrix', {
    keywords: ['campaign', 'benchmark run', 'probes'],
  }),
  field('advanced.capabilityMatrix.history', 'Matrix run history', 'advanced', 'capability-matrix', {
    keywords: ['campaign history', 'sweep'],
  }),
  field('advanced.capabilityMatrix.cell', 'Cell transcript', 'advanced', 'capability-matrix', {
    keywords: ['verdict', 'note', 'override', 'manual cell', 'transcript', 'drawer'],
  }),
  field('advanced.capabilityMatrix.export', 'Export capability matrix', 'advanced', 'capability-matrix', {
    keywords: ['xlsx', 'spreadsheet', 'download', 'export'],
  }),
  field('advanced.capabilityMatrix.import', 'Import capability matrix', 'advanced', 'capability-matrix', {
    keywords: ['xlsx', 'spreadsheet', 'upload', 'import', 'merge'],
  }),
  field('advanced.capabilityMatrix.danger', 'Clear manual verdicts', 'advanced', 'capability-matrix', {
    keywords: ['reset', 'clear manual', 'danger'],
  }),

  field('advanced.boardTesting', 'Board testing', 'advanced', 'board-testing', {
    keywords: ['orchestrate', 'fake model', 'seed board', 'board log', 'kanban', 'test board'],
    description:
      'Manual orchestrate board workflow: in-process fake model, seed test board, catalog scenarios.',
  }),
  field('advanced.boardTesting.fakeModel', 'Fake model', 'advanced', 'board-testing', {
    keywords: ['fake-board', 'openai stub', 'deterministic model'],
  }),
  field('advanced.boardTesting.seed', 'Seed test board', 'advanced', 'board-testing', {
    keywords: ['quick preset', 'smoke preset', 'planner'],
  }),
  field('advanced.boardTesting.log', 'Board log validation', 'advanced', 'board-testing', {
    keywords: ['jsonl', 'invariants', 'check-board-log', 'orchestrate log', 'retired'],
    description: 'V1 JSONL invariant checking is retired. Use the journal under ~/.minnow/boards/.',
  }),

  field('about.info', 'Build info', 'general', 'about', {
    keywords: ['version', 'platform', 'node', 'electron'],
  }),
  field('about.version', 'App version', 'general', 'about'),
];

/** Searchable catalog rows (release-gated optional apps, dev-only board testing). */
export const SETTINGS_FIELD_CATALOG: SettingsFieldEntry[] = filterSettingsCatalogEntries(
  SETTINGS_FIELD_CATALOG_ALL,
);
