import DEFAULT_SUB_AGENTS from '../agents/defaults/sub-agents.json';
import { listWorkAgents } from '../agents/work-agent-registry';
import { listExperts } from '../chat/experts/registry';
import { listModes } from '../chat/modes/registry';
import { isModeVisibleInSettingsSearch } from '../chat/modes/settings-visibility';
import { isDeveloperReleased } from '../os/app-registry';
import {
  BUILT_IN_TOOLS,
  type ToolCategory,
} from '../tools/definitions';
import {
  SETTINGS_CATEGORY_LABELS,
  SETTINGS_NAV_GROUPS,
  SETTINGS_SECTION_LABELS,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from './settings-page-types';
import { SETTINGS_FIELD_CATALOG } from './settings-catalog';
import { modelsSectionForSettingsArea } from './models-settings-navigation';
import type { SettingsSearchEntry } from './settings-search-types';
import { resolveSettingsSectionNavigation } from './settings-section-navigation';

const TOOL_CATEGORY_LABELS: Record<ToolCategory, string> = {
  web: 'Web',
  utility: 'Utility',
  browser: 'Built-in browser',
  agents: 'Sub-agents',
  files: 'Files',
  git: 'Git',
  code: 'Code',
  lsp: 'LSP',
};

/** Extra keywords and section overrides for common aliases. */
const SECTION_SEARCH_ALIASES: Partial<
  Record<SettingsSectionId, string[]>
> = {
  general: ['startup', 'setup', 'onboarding', 'tray', 'login'],
  terminal: ['shell', 'powershell', 'bash', 'command', 'console'],
  data: ['network', 'lan', 'wifi', 'remote', 'backup', 'restore', 'privacy', 'filesystem', 'disk access'],
  updates: ['update', 'version', 'upgrade', 'restart'],
  notifications: ['notifications', 'bell', 'sound', 'alert', 'background chat', 'menubar'],
  diagnostics: ['health', 'errors', 'logs', 'crash', 'report', 'subsystem', 'issues', 'auto-file'],
  'agent-center': ['prompts', 'prompt', 'profile', 'system prompt', 'modes', 'work agents', 'sub-agents'],
  injection: ['brain notes', 'memory injection', 'code map injection', 'context documents', 'composer context', 'chat context'],
  watchdog: ['watchdog', 'timeouts', 'recovery', 'stuck', 'hangs'],
  rules: ['user rules', 'cursor rules', 'rule'],
  'model-routing': ['models', 'routing', 'bindings'],
  providers: ['api', 'lm studio', 'openai'],
  search: ['web search', 'brave', 'tavily', 'searxng', 'duckduckgo', 'ddg'],
  servers: ['searxng', 'managed server', 'local search', 'metasearch', 'install searxng'],
  tools: ['permissions', 'tool cache', 'let agents edit files', 'allow file editing', 'approval'],
  mcp: ['model context protocol'],
  webhooks: ['outgoing webhook', 'hmac', 'automation', 'signed events'],
  lsp: ['language server', 'typescript server'],
  audio: ['microphone', 'speaker', 'devices', 'dictation', 'echo', 'gain'],
};

/** Voice I/O keywords route to Models → Voice (not a settings section). */
const MODELS_VOICE_SEARCH: SettingsSearchEntry = {
  id: 'models:voice',
  label: 'Voice',
  sectionId: 'audio',
  kind: 'models-section',
  modelsSection: 'voice',
  keywords: [
    'voice',
    'speech',
    'stt',
    'tts',
    'read aloud',
    'dictation',
    'whisper',
    'qwen',
    'text to speech',
    'speech to text',
    'models voice',
  ],
  hint: 'Models app',
};

/** llama.cpp / MLX runtimes (and llama.cpp forks) route to Models → Engine. */
const MODELS_ENGINE_SEARCH: SettingsSearchEntry = {
  id: 'models:engine',
  label: 'Inference engine',
  sectionId: 'servers',
  kind: 'models-section',
  modelsSection: 'engine',
  keywords: [
    'engine',
    'llama.cpp',
    'llama-server',
    'llama cpp',
    'fork',
    'turbo3',
    'turboquant',
    'mlx',
    'mlx-lm',
    'runtime',
    'install llama',
    'cuda build',
  ],
  hint: 'Models app',
};

/** Memory settings moved to the Brain app. */
const BRAIN_MEMORY_SEARCH: SettingsSearchEntry[] = [
  {
    id: 'brain:memories',
    label: 'Memory store',
    sectionId: 'prompting',
    kind: 'brain-section',
    brainSection: 'memories',
    searchKey: 'knowledge.memory',
    keywords: ['memory', 'memories', 'recall', 'memory store', 'memory enabled'],
    hint: 'Brain app',
  },
  {
    id: 'brain:memories-enabled',
    label: 'Enable memory store',
    sectionId: 'prompting',
    kind: 'brain-section',
    brainSection: 'memories',
    searchKey: 'knowledge.memory.enabled',
    keywords: ['enable memory', 'disable memory', 'turn off memory'],
    hint: 'Brain app',
  },
  {
    id: 'brain:embeddings',
    label: 'Semantic embeddings',
    sectionId: 'prompting',
    kind: 'brain-section',
    brainSection: 'settings',
    searchKey: 'knowledge.memory.embeddings',
    keywords: ['embeddings', 'vector', 'semantic search', 'hybrid retrieval'],
    hint: 'Brain app',
  },
  {
    id: 'brain:synthesis',
    label: 'Auto-learning cadence',
    sectionId: 'prompting',
    kind: 'brain-section',
    brainSection: 'settings',
    searchKey: 'knowledge.memory.synthesis',
    keywords: ['synthesis', 'auto-learning', 'skill learning', 'proposals cadence'],
    hint: 'Brain app',
  },
];

// ── Nav ──────────────────────────────────────────────────────────────────────

function sectionEntry(sectionId: SettingsSectionId): SettingsSearchEntry {
  const label = SETTINGS_SECTION_LABELS[sectionId];
  return {
    id: `section:${sectionId}`,
    label,
    sectionId,
    kind: 'section',
    keywords: [
      sectionId,
      label.toLowerCase(),
      ...(SECTION_SEARCH_ALIASES[sectionId] ?? []),
    ],
    hint: 'Section',
  };
}

function navGroupEntries(): SettingsSearchEntry[] {
  return SETTINGS_NAV_GROUPS.map((group) => ({
    id: `nav-group:${group.id}`,
    label: group.label,
    sectionId: group.sections[0]!,
    kind: 'nav-group' as const,
    keywords: [
      group.id,
      group.label.toLowerCase(),
      ...group.sections,
      ...group.sections.map((s) => SETTINGS_SECTION_LABELS[s].toLowerCase()),
    ],
    hint: 'Group',
  }));
}

// ── Tools ────────────────────────────────────────────────────────────────────

function toolCategoryEntries(): SettingsSearchEntry[] {
  const seen = new Set<ToolCategory>();
  for (const tool of BUILT_IN_TOOLS) {
    seen.add(tool.category);
  }
  return [...seen].map((category) => ({
    id: `tool-category:${category}`,
    label: TOOL_CATEGORY_LABELS[category],
    sectionId: category === 'web' ? ('search' as const) : ('tools' as const),
    kind: 'tool-category' as const,
    searchKey: `tools.category.${category}`,
    keywords: [category, 'tools', TOOL_CATEGORY_LABELS[category].toLowerCase()],
    hint: 'Tools',
  }));
}

function toolEntries(): SettingsSearchEntry[] {
  return BUILT_IN_TOOLS.map((tool) => ({
    id: `tool:${tool.id}`,
    label: tool.label,
    sectionId: tool.category === 'web' ? ('search' as const) : ('tools' as const),
    kind: 'tool' as const,
    searchKey: `tools.item.${tool.id}`,
    keywords: [
      tool.id,
      tool.description.toLowerCase(),
      tool.category,
      TOOL_CATEGORY_LABELS[tool.category].toLowerCase(),
    ],
    hint: 'Tool',
  }));
}

function modeEntries(): SettingsSearchEntry[] {
  return listModes()
    .filter((mode) => isModeVisibleInSettingsSearch(mode.id))
    .map((mode) => ({
    id: `mode:${mode.id}`,
    label: mode.label,
    sectionId: 'agent-center' as const,
    kind: 'mode' as const,
    searchKey: `modes.${mode.id}`,
    keywords: [mode.id, mode.description.toLowerCase(), 'composer mode'],
    hint: 'Mode',
  }));
}

function expertEntries(): SettingsSearchEntry[] {
  if (!isDeveloperReleased('experts')) {
    return [];
  }
  return listExperts().map((expert) => ({
    id: `expert:${expert.meta.id}`,
    label: expert.meta.label,
    sectionId: 'agent-center' as const,
    kind: 'expert' as const,
    searchKey: `experts.${expert.meta.id}`,
    keywords: [expert.meta.id, 'expert', 'persona'],
    hint: 'Agents',
  }));
}

// ── Agents ───────────────────────────────────────────────────────────────────

function workAgentEntries(): SettingsSearchEntry[] {
  return listWorkAgents(true).map((agent) => ({
    id: `work-agent:${agent.id}`,
    label: agent.label,
    sectionId: 'agent-center' as const,
    kind: 'work-agent' as const,
    searchKey: `work-agents.${agent.id}`,
    keywords: [agent.id, 'work agent', 'agent'],
    hint: 'Work agent',
  }));
}

function subAgentEntries(): SettingsSearchEntry[] {
  const types = DEFAULT_SUB_AGENTS.types as Record<
    string,
    { label?: string }
  >;
  return Object.entries(types).map(([typeId, cfg]) => ({
    id: `sub-agent:${typeId}`,
    label: cfg.label?.trim() || typeId,
    sectionId: 'agent-center' as const,
    kind: 'sub-agent' as const,
    searchKey: `sub-agents.${typeId}`,
    keywords: [typeId, 'sub-agent', 'sub agent', 'spawn'],
    hint: 'Sub-agent type',
  }));
}

function catalogFieldEntries(): SettingsSearchEntry[] {
  return SETTINGS_FIELD_CATALOG.map((field) => {
    const resolved = resolveSettingsSectionNavigation(field.area, field.key);
    const modelsSection = modelsSectionForSettingsArea(field.area);
    return {
      id: `field:${field.key}`,
      label: field.label,
      sectionId: resolved.sectionId,
      kind: modelsSection ? ('models-section' as const) : ('field' as const),
      ...(modelsSection ? { modelsSection } : { searchKey: field.key }),
      keywords: [
        field.key,
        field.category,
        ...(field.keywords ?? []),
        ...(field.description ? [field.description.toLowerCase()] : []),
      ],
      hint: modelsSection ? 'Models app' : SETTINGS_CATEGORY_LABELS[field.category],
    };
  });
}

// ── Index ────────────────────────────────────────────────────────────────────

/** Build the full searchable catalog from registries and field catalog. */
export function buildSettingsSearchIndex(): SettingsSearchEntry[] {
  const sections = SETTINGS_SECTIONS.map(sectionEntry);
  return [
    ...sections,
    { id: 'models:setup', label: 'Models & connections', sectionId: 'providers', kind: 'models-section', modelsSection: 'providers', keywords: ['change model', 'connect model', 'setup model', 'lm studio', 'api key', 'provider'], hint: 'Models app' },
    { id: 'task:mute', label: 'Play notification sounds', sectionId: 'notifications', kind: 'field', searchKey: 'general.notifications.sound', keywords: ['stop sounds', 'mute', 'silence', 'sound off', 'disable sounds', 'turn off sounds'] },
    MODELS_VOICE_SEARCH,
    MODELS_ENGINE_SEARCH,
    ...BRAIN_MEMORY_SEARCH,
    ...navGroupEntries(),
    ...catalogFieldEntries(),
    ...toolCategoryEntries(),
    ...toolEntries(),
    ...modeEntries(),
    ...expertEntries(),
    ...workAgentEntries(),
    ...subAgentEntries(),
  ].map((entry) => {
    const result = entry as SettingsSearchEntry;
    if (result.kind === 'models-section' || result.kind === 'brain-section') return result;
    const group = SETTINGS_NAV_GROUPS.find((g) => g.sections.includes(result.sectionId));
    return { ...result, hint: group ? `${group.label} › ${SETTINGS_SECTION_LABELS[result.sectionId]}` : result.hint };
  });
}
