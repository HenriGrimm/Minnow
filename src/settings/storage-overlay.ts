/**
 * Storage overlay — maps catalog keys to persistence paths for agent settings tools.
 * Section-only keys inherit defaults from SETTINGS_FIELD_CATALOG (writable: false).
 */

import type { SettingsFieldDef, SettingsFieldType, SettingsSensitivity, SettingsStorageKind } from './types';
import type { SettingsSectionId } from '../ui/settings-page-types';

type OverlayEntry = Partial<
  Pick<
    SettingsFieldDef,
    | 'storage'
    | 'path'
    | 'resource'
    | 'type'
    | 'allowedValues'
    | 'sensitivity'
    | 'writable'
    | 'refreshAreas'
  >
>;

function meta(
  path: string,
  type: SettingsFieldType,
  extras?: OverlayEntry,
): OverlayEntry {
  return { storage: 'meta', path, type, writable: true, sensitivity: 'normal', ...extras };
}

function resource(
  resourceName: string,
  path: string,
  type: SettingsFieldType,
  extras?: OverlayEntry,
): OverlayEntry {
  return {
    storage: 'resource',
    resource: resourceName,
    path,
    type,
    writable: true,
    sensitivity: 'normal',
    ...extras,
  };
}

function browser(
  path: string,
  type: SettingsFieldType,
  extras?: OverlayEntry,
): OverlayEntry {
  return { storage: 'browser', path, type, writable: true, sensitivity: 'normal', ...extras };
}

function section(refreshAreas?: SettingsSectionId[]): OverlayEntry {
  return { storage: 'section', writable: false, type: 'string', sensitivity: 'normal', refreshAreas };
}

/** Writable and section-only storage mappings keyed by catalog id. */
export const SETTINGS_STORAGE_OVERLAY: Record<string, OverlayEntry> = {
  'general.updates': section(['general']),
  'general.updates.channel': section(['general']),
  'general.notifications': section(['notifications']),
  'general.notifications.enabled': browser('enabled', 'boolean', { refreshAreas: ['notifications'] }),
  'general.notifications.chat': browser('chatEnabled', 'boolean', { refreshAreas: ['notifications'] }),
  'general.notifications.tasks': browser('tasksEnabled', 'boolean', { refreshAreas: ['notifications'] }),
  'general.notifications.background': browser('backgroundEnabled', 'boolean', {
    refreshAreas: ['notifications'],
  }),
  'general.notifications.sound': browser('soundEnabled', 'boolean', { refreshAreas: ['notifications'] }),
  'general.notifications.soundOnActiveChat': browser('soundOnActiveChat', 'boolean', {
    refreshAreas: ['notifications'],
  }),
  'general.network': meta('server.networkAccess', 'enum', {
    allowedValues: ['local', 'lan'],
    sensitivity: 'dangerous',
    refreshAreas: ['general'],
  }),
  'general.desktop': section(['general']),
  'general.desktop.closeToTray': meta('desktopShell.closeToTray', 'boolean', {
    refreshAreas: ['general'],
  }),
  'general.desktop.windowCloseAction': meta('desktopShell.windowCloseAction', 'enum', {
    allowedValues: ['ask', 'close', 'background'],
    refreshAreas: ['general'],
  }),
  'general.desktop.zoom': meta('desktopShell.zoomPercent', 'number', {
    refreshAreas: ['general'],
  }),
  'general.desktop.launchAtStartup': section(['general']),
  'general.chat.terminal': section(['general']),
  'general.toolCalls.constrained': meta('toolCalls.useConstrainedDecoding', 'boolean', {
    refreshAreas: ['general', 'tools'],
  }),
  'agents.watchdog': section(['watchdog']),
  'agents.watchdog.generation': meta('chat.generationIdleTimeoutMs', 'number', {
    refreshAreas: ['watchdog'],
  }),
  'audio.devices': section(['audio']),
  'audio.inputDevice': meta('voice.audio.inputDeviceId', 'string', { refreshAreas: ['audio'] }),
  'audio.outputDevice': meta('voice.audio.outputDeviceId', 'string', { refreshAreas: ['audio'] }),
  'audio.echoCancellation': meta('voice.audio.echoCancellation', 'boolean', {
    refreshAreas: ['audio'],
  }),
  'audio.noiseSuppression': meta('voice.audio.noiseSuppression', 'boolean', {
    refreshAreas: ['audio'],
  }),
  'audio.autoGainControl': meta('voice.audio.autoGainControl', 'boolean', {
    refreshAreas: ['audio'],
  }),

  'appearance.theme': section(['appearance']),
  'appearance.theme.family': browser('themeFamily', 'enum', {
    allowedValues: ['swamp', 'desert', 'ocean', 'coral', 'mono', 'matrix', 'human', 'mint'],
    refreshAreas: ['appearance'],
    writable: false,
  }),
  'appearance.theme.mode': browser('themeMode', 'enum', {
    allowedValues: ['dark', 'light', 'system'],
    refreshAreas: ['appearance'],
    writable: false,
  }),
  'appearance.fonts': section(['appearance']),
  'appearance.customColors': section(['appearance']),

  'apps.issues.types': resource('issues-taxonomy', 'types', 'json', { refreshAreas: ['issues'] }),
  'apps.issues.statuses': resource('issues-taxonomy', 'statuses', 'json', {
    refreshAreas: ['issues'],
  }),
  'apps.issues.priorities': resource('issues-taxonomy', 'priorities', 'json', {
    refreshAreas: ['issues'],
  }),

  'models.providers': section(['providers']),
  'models.providers.add': section(['providers']),
  'models.routing': section(['model-routing']),
  'models.routing.goalEval': section(['model-routing']),
  'models.routing.utilityTasks': section(['model-routing']),
  'models.sampler': section(['sampler']),
  'models.sampler.temperature': meta('sampler.temperature', 'number', { refreshAreas: ['sampler'] }),
  'models.sampler.topP': meta('sampler.topP', 'number', { refreshAreas: ['sampler'] }),
  'models.sampler.topK': meta('sampler.topK', 'number', { refreshAreas: ['sampler'] }),
  'models.sampler.minP': meta('sampler.minP', 'number', { refreshAreas: ['sampler'] }),
  'models.sampler.repetitionPenalty': meta('sampler.repetitionPenalty', 'number', {
    refreshAreas: ['sampler'],
  }),
  'models.sampler.presencePenalty': meta('sampler.presencePenalty', 'number', {
    refreshAreas: ['sampler'],
  }),
  'models.sampler.maxTokens': meta('sampler.maxTokens', 'number', { refreshAreas: ['sampler'] }),
  'models.thinking': section(['thinking']),
  'models.usage': section(['usage']),

  'agents.center': section(['agent-center']),
  'agents.modes': section(['agent-center']),
  'agents.experts': section(['agent-center']),
  'agents.workAgents': section(['agent-center']),
  'agents.agentPacks': section(['agent-packs']),
  'agents.subAgents': section(['agent-center']),
  'agents.autopilot': section(['autopilot']),
  'agents.autopilot.defaultStatus': meta('autopilot.defaultStatus', 'enum', {
    allowedValues: ['running', 'stopped'],
    refreshAreas: ['autopilot'],
  }),
  'agents.autopilot.isolation': meta('autopilot.defaultIsolationMode', 'enum', {
    allowedValues: ['auto', 'off', 'per-board', 'per-task', 'per-wave'],
    refreshAreas: ['autopilot'],
  }),
  'agents.autopilot.concurrency': meta('autopilot.maxConcurrentTasks', 'number', {
    refreshAreas: ['autopilot'],
  }),
  'agents.autopilot.plannerModel': section(['autopilot']),
  'agents.autopilot.selfHeal': section(['autopilot']),
  'agents.autopilot.selfHealMaxRounds': meta('autopilot.selfHealMaxRounds', 'number', {
    refreshAreas: ['autopilot'],
  }),
  'agents.autopilot.infraProvisionTimeout': meta('autopilot.infraProvisionTimeoutMs', 'number', {
    refreshAreas: ['autopilot'],
  }),
  'agents.autopilot.autoProvisionInfra': meta('autopilot.autoProvisionInfra', 'boolean', {
    refreshAreas: ['autopilot'],
  }),
  'agents.autopilot.afkAutoRestartStalls': meta('autopilot.afkAutoRestartStalls', 'boolean', {
    refreshAreas: ['autopilot'],
  }),
  'agents.autopilot.guardCdOutsideWorktree': meta('autopilot.guardCdOutsideWorktree', 'boolean', {
    refreshAreas: ['autopilot'],
  }),
  'agents.prompting': section(['agent-center']),
  'agents.prompting.profiles': section(['agent-center']),
  'agents.prompting.hub': section(['agent-center']),
  'agents.rules': section(['rules']),
  'agents.rules.enabled': resource('rules', 'enabled', 'boolean', { refreshAreas: ['rules'] }),
  'agents.rules.items': section(['rules']),
  'agents.rules.addGroup': section(['rules']),
  'agents.rules.deleteGroup': section(['rules']),

  'integrations.search': section(['search']),
  'integrations.search.provider': resource('search', 'provider', 'enum', {
    allowedValues: ['searxng', 'tavily', 'brave', 'duckduckgo', 'disabled'],
    refreshAreas: ['search'],
  }),
  'integrations.search.apiKeys': resource('search', 'keys', 'json', {
    sensitivity: 'secret',
    refreshAreas: ['search'],
  }),
  'integrations.deepResearch': section(['deep-research']),
  'integrations.servers': section(['servers']),
  'integrations.tools': section(['tools']),
  'general.filesystem': meta('toolSecurity.filesystemAccess', 'enum', {
    allowedValues: ['workspace', 'full'],
    sensitivity: 'dangerous',
    refreshAreas: ['general'],
  }),
  'general.shellSandbox': meta('toolSecurity.shellSandbox', 'enum', {
    allowedValues: ['off', 'prefer', 'require'],
    sensitivity: 'dangerous',
    refreshAreas: ['general'],
  }),
  'integrations.mcp': section(['mcp']),
  'integrations.lsp': section(['lsp']),
  'integrations.editor': section(['editor']),
  'integrations.skills': section(['skills']),
  'integrations.webhooks': section(['webhooks']),
  'integrations.tools.lazyLoading': resource('tools', 'lazyTools', 'boolean', {
    refreshAreas: ['tools'],
  }),
  'integrations.tools.cache': resource('tools', 'toolCache.enabled', 'boolean', {
    refreshAreas: ['tools'],
  }),
  'integrations.tools.outputCap': resource('tools', 'toolOutput.enabled', 'boolean', {
    refreshAreas: ['tools'],
  }),
  'integrations.tools.outputCap.maxChars': resource('tools', 'toolOutput.maxChars', 'number', {
    refreshAreas: ['tools'],
  }),
  'integrations.browser': meta('browser.enabled', 'boolean', { refreshAreas: ['browser'] }),

  'advanced.diagnostics.fileErrorsToIssues': browser('fileErrorsToIssues', 'boolean', {
    refreshAreas: ['diagnostics'],
  }),
  'advanced.capabilityMatrix': section(['capability-matrix']),
  'advanced.capabilityMatrix.roster': section(['capability-matrix']),
  'advanced.capabilityMatrix.grid': section(['capability-matrix']),
  'advanced.capabilityMatrix.run': section(['capability-matrix']),
  'advanced.capabilityMatrix.history': section(['capability-matrix']),
  'advanced.capabilityMatrix.cell': section(['capability-matrix']),
  'advanced.capabilityMatrix.export': section(['capability-matrix']),
  'advanced.capabilityMatrix.import': section(['capability-matrix']),
  'advanced.capabilityMatrix.danger': section(['capability-matrix']),
};

/** Default overlay for keys without explicit mapping. */
export const DEFAULT_OVERLAY: OverlayEntry = section();

/** Build a tool-permission registry entry for one built-in tool id. */
export function toolPermissionFieldDef(toolId: string): SettingsFieldDef {
  return {
    key: `integrations.tools.permission.${toolId}`,
    label: `Tool permission: ${toolId}`,
    description: `Permission mode for the ${toolId} tool (off, ask, or full).`,
    keywords: [toolId, 'permission', 'tools'],
    category: 'integrations',
    area: 'tools',
    storage: 'resource',
    resource: 'tools',
    path: `permissions.default.${toolId}`,
    type: 'enum',
    allowedValues: ['off', 'ask', 'full'],
    sensitivity: 'normal',
    writable: true,
    refreshAreas: ['tools'],
  };
}
