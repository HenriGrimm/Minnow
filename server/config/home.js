/**
 * Resolve Minnow user data directory (~/.minnow) and ensure layout exists.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ALL_TOOL_IDS, BRAIN_FULL_PERMISSION_TOOL_ID_SET } from './tool-ids.js';
import { defaultServersConfig } from './validators.js';

/** Cached resolved home path for this process. */
let cachedHome = null;
/** Cached one-time layout initialization for the active home. */
let layoutInitialization = null;

const LEGACY_DIR_NAME = '.speedchat';
const HOME_DIR_NAME = '.minnow';

/**
 * Canonical Minnow home directory.
 * Override with MINNOW_HOME (or legacy SPEEDCHAT_HOME) for tests; otherwise ~/.minnow.
 * Renames ~/.speedchat → ~/.minnow on first run when only the legacy folder exists.
 */
export function getMinnowHome() {
  if (cachedHome) return cachedHome;

  const override =
    (typeof process.env.MINNOW_HOME === 'string' && process.env.MINNOW_HOME.trim()) ||
    (typeof process.env.SPEEDCHAT_HOME === 'string' && process.env.SPEEDCHAT_HOME.trim());
  if (override) {
    cachedHome = path.resolve(override);
    return cachedHome;
  }

  const home = path.join(os.homedir(), HOME_DIR_NAME);
  const legacy = path.join(os.homedir(), LEGACY_DIR_NAME);
  if (!fs.existsSync(home) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, home);
    } catch {
      cachedHome = legacy;
      return cachedHome;
    }
  }

  cachedHome = home;
  return cachedHome;
}

/** Reset cached home (tests only). */
export function resetMinnowHomeCache() {
  cachedHome = null;
  layoutInitialization = null;
}

/** @deprecated Use getMinnowHome */
export const getSpeedChatHome = getMinnowHome;

/** @deprecated Use resetMinnowHomeCache */
export const resetSpeedChatHomeCache = resetMinnowHomeCache;

const SCAFFOLD_DIRS = [
  'chats',
  'workspace',
  'sessions',
  'bugs',
  'issues',
  'reviews',
  'memory',
  'models',
  'models/embeddings',
  'providers',
  'mcp',
  'lsp',
  'prompt-configs',
  'profiles',
  'prompts',
  'skills',
  'tools',
  'agent-packs',
  'backups',
  'logs/sub-agents',
  'logs/servers',
  'logs/terminal',
  'logs/crash',
  'servers',
  'screenshots',
  'benchmarks',
  'evals',
  'evals/packs',
  'evals/runs',
  'runs/shell',
  'scheduler-runs',
  'brain',
  'brain/pages',
  'brain/pages/facts',
  'brain/pages/workspaces',
  'brain/sources',
  'brain/code',
  'research',
  'research/cache',
  'tts-cache',
];

const DEFAULT_META = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  migratedFromLocalStorage: false,
  migratedAt: null,
  localStorageKeysMigrated: [],
  layoutVersion: 1,
  activeProviderId: 'lm-studio-local',
  activePromptProfile: 'full',
  activePromptConfigId: null,
  activeInfoPresetId: 'general-assistant',
  activeSetupProfileId: null,
  workspaceProfiles: {},
  workspaceProfileAutoApply: false,
  titles: {
    enabled: true,
    modelId: '',
    providerId: '',
    maxTokens: 24,
    temperature: 0.3,
  },
  sampler: {
    temperature: 1.0,
    topP: 0.95,
    topK: 20,
    minP: 0,
    repetitionPenalty: 1,
    presencePenalty: 0,
    maxTokens: 32768, // keep in sync with DEFAULT_AGENT_MAX_TOKENS in sampler-types.js
  },
  thinking: {
    defaultMode: 'on',
    thinkingBudgetTokens: null,
  },
  terminal: {
    open: false,
    heightPx: 240,
    autoOpenOnAgentRun: false,
    autoFollowAgentTab: false,
  },
  browser: {
    enabled: true,
    allowNavigate: true,
    allowedOriginPatterns: [
      'http://localhost:*',
      'http://127.0.0.1:*',
      'https://localhost:*',
    ],
  },
  uiDesigner: {
    providerId: '',
    modelId: '',
    fallbackToChatModel: true,
  },
  toolSecurity: {
    filesystemAccess: 'workspace',
  },
  desktopShell: {
    closeToTray: true,
    windowCloseAction: 'ask',
    zoomPercent: 80,
    hardwareAcceleration: true,
  },
  selfHealing: {
    enabled: false,
    tier1: {
      maxRestartsPerParentTurn: 2,
      duplicateToolCallThreshold: 5,
      sameErrorThreshold: 3,
      noProgressTurnThreshold: 4,
    },
    tier2: {
      enabled: true,
      requireScriptApproval: true,
    },
  },
  supervisor: {
    enabled: true,
    autoResume: true,
    repetitionDetection: true,
    llmEscalation: true,
    askUserOnBudgetExhausted: true,
    stallMs: 30_000,
    maxRetriesPerTask: 3,
    orchestratorHeartbeatMs: 90_000,
    inProgressNoRunMs: 45_000,
    spawnStuckMs: 30_000,
    parentSilenceAfterToolMs: 20_000,
    subAgentToolSilenceMs: 60_000,
    runRestartCap: 2,
    spawnCapPerTask: 3,
    llmEscalationsPerSession: 10,
    llmEscalationTimeoutMs: 8_000,
    tickIntervalMs: 5_000,
    repetition: {
      duplicateToolCallThreshold: 5,
      sameErrorThreshold: 3,
      maxRestartsPerRun: 2,
    },
    escalationProviderId: '',
    escalationModelId: '',
  },
  memory: {
    enabled: true,
    maxEntries: 500,
    maxInjectCharsFull: 8000,
    maxInjectCharsLite: 800,
    retrieveLimit: 20,
    defaultTags: [],
    embeddings: {
      enabled: true,
      backend: 'local',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      providerId: '',
      blendWeight: 0.5,
      queryTimeoutMs: 3000,
      reindexNeeded: false,
    },
  },
  brain: {
    linking: {
      minSharedTitleKeywords: 2,
      minCosine: 0.75,
      retireMinCosine: 0.85,
      maxLinks: 3,
    },
  },
  synthesis: {
    enabled: true,
    requireConfirmation: false,
    confidenceThreshold: 0.6,
    autoWriteConfidence: 0.85,
    maxProposalsPerTurn: 3,
    throttleMessagePairs: 4,
    skillMinRounds: 2,
    skillMinToolCalls: 2,
    skillMinOccurrences: 2,
    skillObservationRetentionDays: 45,
    utilityProviderId: '',
    utilityModelId: '',
    maxPendingProposals: 100,
    rejectedRetentionDays: 30,
    includeBoardChats: false,
  },
  planning: {
    granularity: 'medium',
    superPlan: {
      reviewRounds: 2,
      grillQuestionBudget: 20,
      impeccable: 'auto',
      researchScope: 'both',
      researchMaxRounds: 0,
      researchDepth: 'auto',
      models: {
        research: { providerId: '', modelId: '' },
        reviewer: { providerId: '', modelId: '' },
        planner: { providerId: '', modelId: '' },
      },
    },
  },
  chat: {
    generationIdleTimeoutMs: 60 * 60_000,
    generationMaxDurationMs: 240 * 60_000,
  },
  fallbackChains: {
    enabled: false,
    cooldownSeconds: 60,
    maxChainLength: 4,
    roles: {
      _global: [],
      default: [],
      utility: [],
      research: [],
      vision: [],
    },
  },
  editorAiCompletion: {
    enabled: true,
    debounceMs: 450,
    maxPrefixLines: 80,
    maxSuffixLines: 40,
    maxPrefixChars: 6000,
    maxSuffixChars: 2000,
    temperature: 0.3,
    maxTokens: 256,
    useChatModel: true,
    providerId: '',
    modelId: '',
    includeImportContext: true,
    includeLspHover: true,
    includeLspContext: true,
    contextBudgetChars: 4000,
    useNativeFim: true,
    enableCompletionCache: true,
    reindentOnAccept: true,
  },
  gitCommitMessage: {
    useGitmoji: true,
  },
  editorIntentMode: {
    enabledByDefault: false,
    debounceMs: 400,
    contextWindow: 5,
    autoResolveOnLineLeave: false,
    sigil: '',
    providerId: '',
    modelId: '',
    maxTokens: 400,
  },
  editorSettings: {
    fontSize: 13,
    tabSize: 2,
    wordWrap: false,
    renderWhitespace: false,
  },
  voice: {
    stt: {
      enabled: true,
      providerId: '',
      model: 'whisper-1',
      language: 'en',
    },
    tts: {
      enabled: true,
      providerId: '',
      model: 'tts-1',
      voice: 'alloy',
      speed: 1.0,
      format: 'mp3',
    },
    limits: {
      maxAudioBytes: 25 * 1024 * 1024,
      maxDurationSeconds: 300,
      silenceTimeoutSeconds: 2.5,
    },
  },
};

const DEFAULT_SYSTEM_PROMPT = {
  presetId: 'general-assistant',
  text: 'You are a helpful, concise assistant. Respond clearly and directly. Avoid unnecessary preamble.',
};

const DEFAULT_RULES = {
  version: 2,
  enabled: false,
  groups: [{ id: 'general', name: 'General' }],
  rules: [],
};

/** Tool ids enabled on first run (matches client defaultToolConfig). */
const DEFAULT_ENABLED_TOOL_IDS = new Set([
  'get_datetime',
  'calculate',
  'web_search',
  'wikipedia_search',
  'save_memory',
  'ask_question',
  'brain_search',
  'brain_read_page',
  'brain_list',
  'brain_write_page',
  'brain_append_log',
  'brain_ingest_source',
  'manage_brain',
  'search_settings',
  'get_settings',
  'update_settings',
  'get_appearance',
  'update_appearance',
  'upload_appearance_asset',
  'repo_map',
  'find_symbol',
  'who_calls',
  'read_symbol',
  'recall_chat_context',
  'recall_turn_full',
  'read_diagnostics',
]);

function defaultPermissionForTool(id, enabled) {
  if (id === 'search_settings' || id === 'get_settings' || id === 'get_appearance') {
    return enabled ? 'full' : 'off';
  }
  if (id === 'read_diagnostics') {
    return enabled ? 'ask' : 'off';
  }
  if (BRAIN_FULL_PERMISSION_TOOL_ID_SET.has(id)) {
    return enabled ? 'full' : 'off';
  }
  return enabled ? 'ask' : 'off';
}

function defaultToolsJson() {
  const enabled = {};
  const permissionsDefault = {};
  for (const id of ALL_TOOL_IDS) {
    const on = DEFAULT_ENABLED_TOOL_IDS.has(id);
    enabled[id] = on;
    permissionsDefault[id] = defaultPermissionForTool(id, on);
  }
  return {
    enabled,
    permissions: { default: permissionsDefault },
    keys: { braveApiKey: '', tavilyApiKey: '' },
    webSearchProvider: 'duckduckgo',
    plugins: {},
    lazyTools: true,
  };
}

/** Per-skill enable flags; missing ids default to enabled. */
function defaultSkillsJson() {
  return { enabled: {} };
}

function defaultSessionStateJson() {
  const chatId = '00000000-0000-0000-0000-000000000001';
  return {
    version: 6,
    activeId: chatId,
    sidebarCollapsed: false,
    lastActiveChatIdByWorkspace: {},
    groups: [],
    chats: [
      {
        id: chatId,
        name: 'New chat',
        workspacePath: '',
        modelId: '',
        history: [],
        lastStats: null,
        modelInfo: {},
        updatedAt: 0,
        lastMessageAt: 0,
      },
    ],
  };
}

/** Best-effort restrictive permissions on Unix. */
async function chmodSafe(filePath, mode) {
  try {
    await fsp.chmod(filePath, mode);
  } catch {
    /* ignore on Windows or unsupported FS */
  }
}

/**
 * Create home layout and default JSON files when missing.
 * SQLite is the sessions store; only seed state.json when MINNOW_SESSIONS_STORE=json.
 * @returns {Promise<string>} Resolved home path
 */
export async function ensureMinnowLayout() {
  const home = getMinnowHome();
  await fsp.mkdir(home, { recursive: true });
  await chmodSafe(home, 0o700);

  for (const dir of SCAFFOLD_DIRS) {
    const dirPath = path.join(home, dir);
    await fsp.mkdir(dirPath, { recursive: true });
    const keep = path.join(dirPath, '.gitkeep');
    try {
      await fsp.access(keep);
    } catch {
      await fsp.writeFile(keep, '', 'utf8');
    }
  }

  const defaults = [
    { rel: 'config.json', data: DEFAULT_META },
    ...(process.env.MINNOW_SESSIONS_STORE === 'json'
      ? [{ rel: 'sessions/state.json', data: defaultSessionStateJson() }]
      : []),
    { rel: 'tools.json', data: defaultToolsJson() },
    { rel: 'servers.json', data: defaultServersConfig() },
    { rel: 'skills.json', data: defaultSkillsJson() },
    { rel: 'system-prompt.json', data: DEFAULT_SYSTEM_PROMPT },
    { rel: 'rules.json', data: DEFAULT_RULES },
    { rel: 'bugs/state.json', data: { version: 1, bugs: [] } },
    {
      rel: 'evals/config.json',
      data: {
        version: 1,
        maxConcurrency: 2,
        graderProviderId: '',
        graderModelId: '',
        graderTimeoutMs: 30_000,
        saveFullTranscripts: false,
        skipApprovalDuringEval: false,
      },
    },
  ];

  for (const { rel, data } of defaults) {
    const full = path.join(home, rel);
    try {
      await fsp.access(full);
    } catch {
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      if (rel === 'tools.json') {
        await chmodSafe(full, 0o600);
      }
    }
  }

  const { ensureBrainStore } = await import('../brain/store.js');
  await ensureBrainStore();

  return home;
}

/**
 * Initialize the active home once for startup and readiness checks.
 * Other callers keep using ensureMinnowLayout so they can repair deleted files.
 * A failed attempt is evicted so the next request can retry.
 * @returns {Promise<string>} Resolved home path
 */
export function ensureMinnowLayoutInitialized() {
  const home = getMinnowHome();
  if (layoutInitialization?.home === home) {
    return layoutInitialization.promise;
  }

  const promise = ensureMinnowLayout();
  layoutInitialization = { home, promise };
  void promise.catch(() => {
    if (layoutInitialization?.promise === promise) {
      layoutInitialization = null;
    }
  });
  return promise;
}

/** @deprecated Use ensureMinnowLayout */
export const ensureSpeedChatLayout = ensureMinnowLayout;

export {
  DEFAULT_META,
  defaultSessionStateJson,
  defaultToolsJson,
  defaultSkillsJson,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_RULES,
};
