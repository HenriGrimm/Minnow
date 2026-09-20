import { refreshMcpToolCache } from '../tools/client';
import { appAlert, appConfirm, appPrompt } from './app-dialog';
/**
 * Populate full settings page sections from Step 02–18 APIs (no placeholder stubs).
 */

import { PART_ORDER } from '../chat/prompts/prompt-composer';
import { schedulePromptTokenEstimateRefresh } from './settings-prompt-estimate';
import { mountSetupProfilesPanel } from './settings-profiles';
import { loadPromptById } from '../chat/prompts/prompt-loader';
import {
  customPartBaselineProfileHint,
  isPromptPartDiffSupported,
  resolveBuiltinPromptBaselineForPart,
} from '../chat/prompts/prompt-baseline';
import { mountPromptDiffControls } from './prompt-diff-panel';
import {
  deletePromptConfig,
  duplicatePromptConfig,
  listPromptConfigs,
  loadPromptConfig,
  savePromptConfig,
} from '../chat/prompts/prompt-configs';
import type {
  PromptConfig,
  PromptConfigPartSettings,
  PromptPartId,
  PromptProfile,
} from '../chat/prompts/types';
import {
  loadPromptMetaSettings,
  savePromptMetaSettings,
} from '../config/prompt-meta';
import { detectConfigServer } from '../config/storage-mode';
import { loadAutopilotMeta } from '../config/autopilot-meta';
import { listProviders } from '../providers/store';
import { renderProvidersSettingsSection } from './settings-providers';
import { renderUsageSettingsSection } from './settings-usage';
import { renderAudioSettingsSection } from './settings-audio';
import { renderNotificationsSettingsSection } from './settings-notifications';
import { renderNetworkAccessSettings } from './settings-network';
import { renderDesktopShellSettings } from './settings-desktop-shell';
import { renderFilesystemAccessSettings } from './settings-filesystem';
import { renderShellSandboxSettings } from './settings-shell-sandbox';
import { renderAppUpdatesSettings } from './settings-updates';
import { renderAgentPacksSettingsSection } from './settings-agent-packs';
import { renderAutopilotSettingsSection } from './settings-autopilot';
import { renderAgentSupervisionSection } from './settings-watchdog';
import { renderSkillsSettingsSection } from './settings-skills';
import { renderSkillsLibrarySettingsSection } from './settings-skills-library';
import {
  fillToolsSection,
  refreshProvidersBanner,
  registerToolHandlers,
} from './settings';
import {
  importMcpServers,
  deleteMcpServer,
  fetchMcpSecrets,
  fetchMcpServers,
  setMcpServerEnabled,
  updateMcpSecrets,
  type McpServerSummary,
} from '../mcp/client';
import {
  getToolConfig,
  isLocalServerAvailable,
  isToolConfigReadyForSettingsUi,
  loadToolConfigForSettingsUi,
  loadToolConfigIntoDrawer,
  resetBuiltInToolPermissionsToDefaults,
  saveToolConfig,
  setAllBuiltInToolPermissions,
} from '../tools/config';
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  TOOL_OUTPUT_MAX_CHARS_MAX,
  TOOL_OUTPUT_MAX_CHARS_MIN,
  normalizeToolOutputConfig,
} from '../../server/tools/output-cap.js';
import { renderBrowserSettingsSection } from './settings-browser';
import { renderLspSection } from './lsp-settings';
import { renderEditorSection } from './settings-editor';
import { renderMcpHubSettingsSection } from './settings-mcp-hub';
import { setStatus } from './status';
import type { SettingsSectionId } from './settings-page-types';
import {
  appendSettingsCrosslinks,
  appendSettingsGroup,
  linkToSettingsSection,
  linkToModelsSection,
} from './settings-layout';
import '../styles/settings-general.css';
import {
  appendSettingsOfflineHint,
  createSettingsActionsRow,
  createSettingsInputRow,
  createSettingsSelectRow,
} from './settings-controls';
import { renderAboutSettingsSection } from './settings-about';
import { renderDiagnosticsSettingsSection } from './settings-diagnostics';
import { isBoardTestingSettingsVisible } from '../config/dev-surfaces';
import { renderBoardTestingSettingsSection } from './settings-board-testing';
import { renderCapabilityMatrixSettingsSection } from './settings-capability-matrix';
import {
  beginAsyncSectionRender,
  isAsyncSectionRenderStale,
} from './settings-section-render-guard';
import { renderAppearanceSettingsSection } from './settings-appearance';
import { renderAppsSettingsSection } from './settings-apps';
import { renderAgentCenterPanel } from './settings-agent-center';
import { renderRulesSettingsSection } from './settings-rules';
import { renderInjectionSettingsSection } from './settings-injection';
import {
  createSettingsSwitch,
  createSettingsToggleRow,
} from './settings-switch';
import { renderModelRoutingSection } from './settings-model-routing';
import { renderSearchSettingsSection } from './settings-search-section';
import { renderServersSettingsSection } from './settings-servers-section';
import { renderDeepResearchSettingsSection } from './settings-research-section';
import { renderSamplerSettingsSection } from './settings-sampler';
import { renderThinkingSettingsSection } from './settings-thinking';
import { renderWebhooksSettingsSection } from './settings-webhooks';
import { renderIssuesSettingsSection } from './settings-issues';
import {
  getTerminalMetaCached,
  loadTerminalMeta,
  saveTerminalMeta,
} from '../config/terminal-meta';
import { fetchShellProfiles } from '../api/terminal-pty';
import { findWorkspaceMapKey, readWorkspaceMapRow } from '../lib/workspace-scoped-map';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Key this client writes for a shell-profile override. The server rewrites it
 * with `normalizeWorkspacePathKey` (resolve + realpath + lowercase), so reads
 * and deletes match loosely instead of trusting this exact spelling.
 */
function workspaceShellProfileKey(absPath: string): string {
  const trimmed = absPath.trim();
  if (!trimmed) return '';
  const forward = trimmed.replace(/\\/g, '/');
  return /^[a-zA-Z]:\//.test(forward) || /^[a-zA-Z]:\\/.test(trimmed)
    ? forward.toLowerCase()
    : forward;
}
import {
  clampGenerationIdleTimeoutMs,
  clampGenerationMaxDurationMs,
  DEFAULT_GENERATION_IDLE_TIMEOUT_MS,
  DEFAULT_GENERATION_MAX_DURATION_MS,
  generationTimeoutMinutesToMs,
  generationTimeoutMsToMinutes,
  getChatMetaSync,
  isGenerationTimeoutEnabled,
  loadChatMeta,
  saveChatMeta,
} from '../config/chat-meta';
import {
  getToolCallsMetaSync,
  loadToolCallsMeta,
  saveToolCallsMeta,
} from '../config/tool-calls-meta';

const PART_LABELS: Record<PromptPartId, string> = {
  base: 'Base',
  mode: 'Mode',
  expert: 'Expert',
  'tool-usage': 'Tool usage',
  info: 'Info',
  memory: 'Memory',
  'code-map': 'Code map',
  'context-documents': 'Context documents',
  'work-agent': 'Work agent',
  skill: 'Skill',
};

const DEFAULT_PART_SETTINGS: PromptConfigPartSettings = {
  enabled: true,
  contentOverride: null,
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clearMount(id: string): HTMLElement | null {
  const mount = document.getElementById(id);
  if (!mount) return null;
  mount.replaceChildren();
  return mount;
}

// ── Terminal ─────────────────────────────────────────────────────────────────

/** Terminal panel behavior when agents run shell commands (MIN-242). */
async function appendTerminalControls(mount: HTMLElement): Promise<void> {
  await loadTerminalMeta();
  const meta = getTerminalMetaCached();

  let shellProfiles: Awaited<ReturnType<typeof fetchShellProfiles>>['profiles'] = [];
  let configuredDefault = meta.defaultShellProfileId;
  try {
    const fetched = await fetchShellProfiles();
    shellProfiles = fetched.profiles;
    configuredDefault =
      meta.defaultShellProfileId ?? fetched.defaultShellProfileId ?? shellProfiles[0]?.id;
  } catch {
  }

  const wslProfiles = shellProfiles.filter((p) => p.runtime === 'wsl');
  // Always on Windows (PowerShell + cmd); also ungates macOS zsh vs bash.
  if (shellProfiles.length > 1) {
    const { row: shellRow, select: shellSelect } = createSettingsSelectRow(
      'Default shell',
      {
        options: shellProfiles.map((p) => ({ value: p.id, label: p.label })),
        value: configuredDefault ?? shellProfiles[0]?.id ?? 'powershell',
        searchKey: 'general.chat.terminal.defaultShell',
        description:
          wslProfiles.length > 0
            ? 'Used for new terminal tabs and agent execute_command. Pick Git Bash or a WSL distro for Unix tooling, or PowerShell / Command Prompt for native Windows.'
            : 'Used for new terminal tabs and agent execute_command. On Windows, Git Bash appears when Git for Windows is installed.',
      },
    );
    mount.appendChild(shellRow);

    shellSelect.addEventListener('change', () => {
      void (async () => {
        try {
          await saveTerminalMeta({ defaultShellProfileId: shellSelect.value });
          setStatus('ok', 'Default shell updated');
        } catch {
          setStatus('err', 'Could not save default shell');
        }
      })();
    });

    try {
      const workspaceRes = await fetch('/api/workspace', { cache: 'no-store' });
      if (workspaceRes.ok) {
        const workspaceBody = (await workspaceRes.json()) as { path?: string };
        const workspacePath =
          typeof workspaceBody.path === 'string' ? workspaceBody.path : '';
        if (workspacePath) {
          const workspaceKey = workspaceShellProfileKey(workspacePath);
          const workspaceOverride = readWorkspaceMapRow(
            meta.workspaceShellProfiles,
            workspacePath,
          );
          const { row: workspaceShellRow, select: workspaceShellSelect } =
            createSettingsSelectRow('Shell for this workspace', {
              options: [
                { value: '', label: 'Use global default' },
                ...shellProfiles.map((p) => ({ value: p.id, label: p.label })),
              ],
              value: workspaceOverride ?? '',
              searchKey: 'general.chat.terminal.workspaceShell',
              description:
                'Override the default shell for the open Code workspace only. Handy when one repo expects Git Bash or WSL and another uses PowerShell.',
            });
          mount.appendChild(workspaceShellRow);

          workspaceShellSelect.addEventListener('change', () => {
            void (async () => {
              const current = await loadTerminalMeta();
              const nextMap = { ...(current.workspaceShellProfiles ?? {}) };
              const selected = workspaceShellSelect.value;
              // Drop the row under the key the server actually stored, not this
              // client's spelling of it — otherwise "Use global default" never took.
              const storedKey = findWorkspaceMapKey(nextMap, workspacePath);
              if (storedKey !== undefined) delete nextMap[storedKey];
              if (selected) {
                nextMap[storedKey ?? workspaceKey] = selected;
              }
              try {
                await saveTerminalMeta({ workspaceShellProfiles: nextMap });
                setStatus('ok', 'Workspace shell override updated');
              } catch {
                setStatus('err', 'Could not save workspace shell override');
              }
            })();
          });
        }
      }
    } catch {
    }
  }

  const { row: autoOpenRow, input: autoOpenCb } = createSettingsToggleRow(
    'Open terminal when agent runs a command',
    {
      checked: meta.autoOpenOnAgentRun,
      ariaLabel: 'Open terminal when agent runs a command',
      searchKey: 'general.chat.terminal.autoOpenOnAgentRun',
      description:
        'Raises the console when an agent runs execute_command. Off by default so your shell stays uninterrupted.',
    },
  );
  mount.appendChild(autoOpenRow);

  const { row: autoFollowRow, input: autoFollowCb } = createSettingsToggleRow(
    'Switch to Agent tab when agent runs a command',
    {
      checked: meta.autoFollowAgentTab,
      ariaLabel: 'Switch to Agent tab when agent runs a command',
      searchKey: 'general.chat.terminal.autoFollowAgentTab',
      description:
        'Jump to the Agent tab when the console is already open. Off by default; a pulse still signals activity on the Terminal button or Agent tab.',
    },
  );
  mount.appendChild(autoFollowRow);

  const saveTerminalSetting = async (
    patch: Parameters<typeof saveTerminalMeta>[0],
    okMessage: string,
  ): Promise<void> => {
    try {
      await saveTerminalMeta(patch);
      setStatus('ok', okMessage);
    } catch {
      setStatus('err', 'Could not save terminal setting');
    }
  };

  autoOpenCb.addEventListener('change', () => {
    void saveTerminalSetting(
      { autoOpenOnAgentRun: autoOpenCb.checked },
      'Terminal auto-open setting updated',
    );
  });

  autoFollowCb.addEventListener('change', () => {
    void saveTerminalSetting(
      { autoFollowAgentTab: autoFollowCb.checked },
      'Terminal auto-follow setting updated',
    );
  });
}

/** Constrained decoding default (persisted in config.json `toolCalls`). */
async function appendToolCallDefaults(mount: HTMLElement): Promise<void> {
  await loadToolCallsMeta();

  const { row: constrainedRow, input: constrainedCb } = createSettingsToggleRow(
    'Constrained tool calls (global default)',
    {
      checked: getToolCallsMetaSync().useConstrainedDecoding,
      ariaLabel: 'Constrained tool calls global default',
      searchKey: 'general.toolCalls.constrained',
    },
  );
  mount.appendChild(constrainedRow);
  mount.appendChild(
    el(
      'p',
      'settings-field-hint',
      'When your provider supports structured output, Minnow validates tool arguments with JSON Schema. If local models return malformed tool calls, enable structured-output probing under Providers.',
    ),
  );
  const probeLink = linkToSettingsSection('Open Providers →', 'providers');
  const probeWrap = el('p', 'settings-field-hint');
  probeWrap.append('Configure probes under ', probeLink, '.');
  mount.appendChild(probeWrap);

  constrainedCb.addEventListener('change', () => {
    void (async () => {
      try {
        await saveToolCallsMeta({ useConstrainedDecoding: constrainedCb.checked });
        setStatus('ok', 'Constrained tool calls setting updated');
      } catch {
        setStatus('err', 'Could not save constrained tool calls setting');
      }
    })();
  });
}

// ── General ──────────────────────────────────────────────────────────────────

async function renderNotificationsSection(): Promise<void> {
  const mount = clearMount('settingsNotificationsBody');
  if (!mount) return;

  const shell = el('div', 'settings-general');
  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');
  lead.append(
    'Menubar bell alerts when something finishes or fails in the background. Terminal and network options live under ',
    linkToSettingsSection('General', 'general'),
    '.',
  );
  shell.appendChild(lead);

  const content = el('div', 'settings-general__content');
  shell.appendChild(content);
  renderNotificationsSettingsSection(content);
}

async function renderAudioSection(): Promise<void> {
  const mount = clearMount('settingsAudioBody');
  if (!mount) return;

  const shell = el('div', 'settings-general');
  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');
  lead.append(
    'Microphone and speaker for dictation and read-aloud. Speech-to-text and text-to-speech models are under ',
    linkToModelsSection('Models → Voice', 'voice'),
    '.',
  );
  shell.appendChild(lead);

  const content = el('div', 'settings-general__content');
  shell.appendChild(content);
  await renderAudioSettingsSection(content, setStatus);
}

function appendGeneralSectionLead(shell: HTMLElement): void {
  const lead = el('p', 'settings-section-lead');
  lead.append(
    'Terminals, LAN access, and where settings are saved. For theme, open ',
    linkToSettingsSection('Appearance', 'appearance'),
    '. For alerts, open ',
    linkToSettingsSection('Notifications', 'notifications'),
    '.',
  );
  shell.appendChild(lead);
}

async function renderGeneralSection(): Promise<void> {
  const generation = beginAsyncSectionRender('general');
  const mount = clearMount('settingsGeneralBody');
  if (!mount) return;

  const shell = el('div', 'settings-general');
  mount.appendChild(shell);
  appendGeneralSectionLead(shell);

  const serverUp = await detectConfigServer();
  if (isAsyncSectionRenderStale('general', generation)) return;
  if (!serverUp) {
    appendSettingsOfflineHint(
      shell,
      'Open Minnow to save file-backed settings. Values below use browser storage until then.',
    );
  }

  const updates = appendSettingsGroup(
    shell,
    'App updates',
    'Stay on the latest build. Downloads run in the background; restart when you are ready.',
    'general.updates',
    { emphasis: true },
  );
  updates.id = 'settingsAppUpdates';
  renderAppUpdatesSettings(updates);

  const desktop = appendSettingsGroup(
    shell,
    'Desktop app',
    'System tray behavior and whether Minnow opens when you sign in.',
    'general.desktop',
    { emphasis: true },
  );
  desktop.id = 'settingsDesktopShell';
  await renderDesktopShellSettings(desktop);
  if (isAsyncSectionRenderStale('general', generation)) return;

  const chat = appendSettingsGroup(
    shell,
    'Chat & terminal',
    'How the main thread and background shells behave.',
    'general.chat.terminal',
    { emphasis: true },
  );
  await appendTerminalControls(chat);
  if (isAsyncSectionRenderStale('general', generation)) return;

  const filesystem = appendSettingsGroup(
    shell,
    'Filesystem access',
    'Choose whether file and git tools stay inside your open project or can reach anywhere on this computer.',
    'general.filesystem',
    { emphasis: true },
  );
  filesystem.id = 'settingsFilesystemAccess';
  await renderFilesystemAccessSettings(filesystem);
  if (isAsyncSectionRenderStale('general', generation)) return;

  const shellSandbox = appendSettingsGroup(
    shell,
    'Agent shell sandbox',
    'Contain agent one-shot shells with OS filesystem sandboxing (Seatbelt / Landlock). Same mode for normal chats and orchestrate boards. Off by default.',
    'general.shellSandbox',
    { emphasis: true },
  );
  shellSandbox.id = 'settingsShellSandbox';
  await renderShellSandboxSettings(shellSandbox);
  if (isAsyncSectionRenderStale('general', generation)) return;

  const network = appendSettingsGroup(
    shell,
    'Network access',
    'Let other devices on your Wi‑Fi open Minnow in a browser while this PC runs the app.',
    'general.network',
    { emphasis: true },
  );
  network.id = 'settingsNetworkAccess';
  await renderNetworkAccessSettings(network);
  if (isAsyncSectionRenderStale('general', generation)) return;

  const setup = appendSettingsGroup(
    shell,
    'Setup wizard',
    'Re-run the first-launch setup flow (theme, provider, permissions).',
    'general.onboarding',
    { emphasis: true },
  );
  setup.appendChild(
    createSettingsActionsRow(
      [
        {
          label: 'Run setup again',
          variant: 'primary',
          onClick: () => {
            void import('../onboarding').then((m) => m.rerunOnboardingFromSettings());
          },
        },
      ],
      { searchKey: 'general.onboarding' },
    ),
  );

}

// ── Prompting ────────────────────────────────────────────────────────────────

function defaultCustomConfig(id: string, label: string): PromptConfig {
  const parts: PromptConfig['parts'] = {};
  for (const partId of PART_ORDER) {
    parts[partId] = { ...DEFAULT_PART_SETTINGS };
  }
  return {
    id,
    label,
    profile: 'custom',
    parts,
    meta: { createdAt: new Date().toISOString() },
  };
}

let promptingUiBound = false;
let activeCustomConfig: PromptConfig | null = null;

async function renderPromptPartsPanel(
  profile: PromptProfile,
  configId: string | null,
): Promise<void> {
  const mount = clearMount('settingsPromptParts');
  if (!mount) return;

  if (profile === 'custom') {
    if (!configId) {
      mount.appendChild(
        el('p', 'settings-field-hint', 'Select or create a custom configuration.'),
      );
      return;
    }
    const loaded = await loadPromptConfig(configId);
    if (loaded instanceof Error) {
      mount.appendChild(el('p', 'settings-field-hint', loaded.message));
      return;
    }
    activeCustomConfig = loaded;
    renderCustomPartEditors(mount, loaded);
    return;
  }

  activeCustomConfig = null;
  const list = el('div', 'settings-parts-preview');
  for (const partId of PART_ORDER) {
    const kind =
      partId === 'work-agent'
        ? 'work-agent'
        : partId === 'tool-usage'
          ? 'tool-usage'
          : partId;
    const promptId =
      partId === 'base'
        ? 'default'
        : partId === 'mode'
          ? 'build'
          : partId === 'expert'
            ? 'general'
            : partId === 'info'
              ? 'general-assistant'
              : partId === 'tool-usage'
                ? 'default'
                : partId === 'work-agent'
                  ? 'default'
                  : null;

    if (!promptId) {
      const row = el('details', 'settings-part-block');
      row.appendChild(el('summary', '', PART_LABELS[partId]));
      row.appendChild(
        el(
          'p',
          'settings-field-hint',
          'Resolved at send time from session context (memory, skills).',
        ),
      );
      list.appendChild(row);
      continue;
    }

    const body = loadPromptById(kind as 'base', promptId, profile);
    const row = el('details', 'settings-part-block');
    row.open = partId === 'base';
    row.appendChild(el('summary', '', PART_LABELS[partId]));
    const pre = el('pre', 'settings-part-preview');
    pre.textContent = body?.body?.trim() || '(empty)';
    row.appendChild(pre);
    list.appendChild(row);
  }
  mount.appendChild(list);
}

function renderCustomPartEditors(mount: HTMLElement, config: PromptConfig): void {
  void (async () => {
    const profileHint = await customPartBaselineProfileHint();

    for (const partId of PART_ORDER) {
      const settings = config.parts[partId] ?? { ...DEFAULT_PART_SETTINGS };
      const block = el('details', 'settings-part-block');
      block.open = partId === 'base';

      const summary = el('summary', '');
      const { root: enableSwitch, input: enable } = createSettingsSwitch({
        checked: settings.enabled !== false,
        ariaLabel: `Enable ${PART_LABELS[partId]} part`,
      });
      enable.addEventListener('click', (e) => e.stopPropagation());
      enable.addEventListener('change', () => {
        if (!activeCustomConfig) return;
        activeCustomConfig.parts[partId] = {
          ...(activeCustomConfig.parts[partId] ?? DEFAULT_PART_SETTINGS),
          enabled: enable.checked,
        };
        schedulePromptTokenEstimateRefresh();
      });
      summary.appendChild(enableSwitch);
      summary.appendChild(document.createTextNode(` ${PART_LABELS[partId]}`));
      block.appendChild(summary);

      const ta = document.createElement('textarea');
      ta.className = 'settings-part-editor';
      ta.rows = 6;
      ta.value = settings.contentOverride ?? '';
      ta.placeholder = 'Leave empty to use shipped default at send time';

      let lastSavedOverride: string | null = settings.contentOverride;
      let builtinBaseline = '';

      const applyPartToConfig = () => {
        if (!activeCustomConfig) return;
        const trimmed = ta.value.trim();
        activeCustomConfig.parts[partId] = {
          enabled: enable.checked,
          contentOverride: trimmed ? ta.value : null,
        };
        schedulePromptTokenEstimateRefresh();
      };

      ta.addEventListener('input', () => {
        applyPartToConfig();
        if (diffControls) diffControls.refresh();
      });

      block.appendChild(ta);

      let diffControls: ReturnType<typeof mountPromptDiffControls> | null = null;

      if (isPromptPartDiffSupported(partId)) {
        const baseline = await resolveBuiltinPromptBaselineForPart(partId);
        builtinBaseline = baseline;
        diffControls = mountPromptDiffControls(block, {
          getBaseline: () => builtinBaseline,
          getCurrent: () => {
            const trimmed = ta.value.trim();
            return trimmed ? ta.value : builtinBaseline;
          },
          showOfflineHint: true,
          profileHint,
          resetPartLabel: 'Reset part to default',
          onResetPart: async () => {
            const hasUnsaved =
              (ta.value.trim() ? ta.value : null) !== lastSavedOverride;
            if (
              hasUnsaved &&
              !(await appConfirm('Discard unsaved edits and reset this part to shipped default?'))
            ) {
              return;
            }
            if (!activeCustomConfig) return;
            activeCustomConfig.parts[partId] = {
              enabled: enable.checked,
              contentOverride: null,
            };
            ta.value = '';
            lastSavedOverride = null;
            const saved = await savePromptConfig(activeCustomConfig);
            if (saved instanceof Error) {
              setStatus('err', saved.message);
              return;
            }
            schedulePromptTokenEstimateRefresh();
            setStatus('ok', `${PART_LABELS[partId]} reset to shipped default`);
          },
        });
        diffControls.setBaseline(builtinBaseline);
      } else {
        const hint = el(
          'p',
          'settings-field-hint',
          'Diff not available — this part is resolved from the active chat at send time.',
        );
        block.appendChild(hint);
      }

      mount.appendChild(block);
    }
  })();
}

async function refreshCustomConfigSelect(): Promise<void> {
  const select = document.getElementById(
    'settingsCustomConfigSelect',
  ) as HTMLSelectElement | null;
  if (!select) return;

  const meta = await loadPromptMetaSettings();
  const configs = await listPromptConfigs();
  select.replaceChildren();
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = configs.length ? '— Select configuration —' : '— No saved configs —';
  select.appendChild(empty);

  for (const item of configs) {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.label;
    select.appendChild(opt);
  }

  if (meta.activePromptConfigId) {
    select.value = meta.activePromptConfigId;
  }
}

async function bindPromptingToolbar(): Promise<void> {
  if (promptingUiBound) return;
  promptingUiBound = true;

  const customBar = document.getElementById('settingsCustomConfigBar');
  const select = document.getElementById(
    'settingsCustomConfigSelect',
  ) as HTMLSelectElement | null;

  const syncCustomBarVisibility = async () => {
    const meta = await loadPromptMetaSettings();
    customBar?.classList.toggle('hidden', meta.activePromptProfile !== 'custom');
    await renderPromptPartsPanel(meta.activePromptProfile, meta.activePromptConfigId);
  };

  select?.addEventListener('change', () => {
    void (async () => {
      const id = select.value || null;
      await savePromptMetaSettings({ activePromptConfigId: id });
      await renderPromptPartsPanel('custom', id);
      schedulePromptTokenEstimateRefresh();
    })();
  });

  document.getElementById('settingsCustomConfigNew')?.addEventListener('click', () => {
    void (async () => {
      const label = await appPrompt('Configuration label:', 'My setup');
      if (!label?.trim()) return;
      const id = label
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48);
      if (!id) return;
      const config = defaultCustomConfig(id, label.trim());
      const saved = await savePromptConfig(config);
      if (saved instanceof Error) {
        setStatus('err', saved.message);
        return;
      }
      await savePromptMetaSettings({
        activePromptProfile: 'custom',
        activePromptConfigId: id,
      });
      await refreshCustomConfigSelect();
      select!.value = id;
      await syncCustomBarVisibility();
      setStatus('ok', `Created ${label}`);
    })();
  });

  document.getElementById('settingsCustomConfigSave')?.addEventListener('click', () => {
    void (async () => {
      if (!activeCustomConfig) {
        setStatus('err', 'No configuration loaded');
        return;
      }
      activeCustomConfig.meta = {
        ...activeCustomConfig.meta,
        updatedAt: new Date().toISOString(),
      };
      const saved = await savePromptConfig(activeCustomConfig);
      setStatus(saved instanceof Error ? 'err' : 'ok', saved instanceof Error ? saved.message : 'Configuration saved');
      if (!(saved instanceof Error)) schedulePromptTokenEstimateRefresh();
    })();
  });

  document.getElementById('settingsCustomConfigDuplicate')?.addEventListener('click', () => {
    void (async () => {
      const meta = await loadPromptMetaSettings();
      if (!meta.activePromptConfigId) return;
      const newLabel = await appPrompt('Duplicate as:', 'Copy');
      if (!newLabel?.trim()) return;
      const newId = `${meta.activePromptConfigId}-copy`
        .slice(0, 48)
        .replace(/[^a-z0-9-]/g, '-');
      const result = await duplicatePromptConfig(
        meta.activePromptConfigId,
        newId,
        newLabel.trim(),
      );
      if (result instanceof Error) {
        setStatus('err', result.message);
        return;
      }
      await refreshCustomConfigSelect();
      await savePromptMetaSettings({ activePromptConfigId: newId });
      select!.value = newId;
      await syncCustomBarVisibility();
      setStatus('ok', 'Configuration duplicated');
    })();
  });

  document.getElementById('settingsCustomConfigDelete')?.addEventListener('click', () => {
    void (async () => {
      const meta = await loadPromptMetaSettings();
      if (!meta.activePromptConfigId) return;
      if (
        !(await appConfirm(`Delete "${meta.activePromptConfigId}"?`, {
          confirmLabel: 'Delete',
          danger: true,
        }))
      ) {
        return;
      }
      const result = await deletePromptConfig(meta.activePromptConfigId);
      if (result instanceof Error) {
        setStatus('err', result.message);
        return;
      }
      await savePromptMetaSettings({ activePromptConfigId: null });
      await refreshCustomConfigSelect();
      await syncCustomBarVisibility();
      setStatus('ok', 'Configuration deleted');
    })();
  });

  document.querySelectorAll('[data-profile-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      void syncCustomBarVisibility().then(() => schedulePromptTokenEstimateRefresh());
    });
  });

  await syncCustomBarVisibility();
}

async function renderAgentCenterBasePrompts(): Promise<void> {
  const profilesMount = document.getElementById('settingsSetupProfilesMount');
  if (profilesMount) {
    mountSetupProfilesPanel(profilesMount, setStatus);
  }
  await refreshCustomConfigSelect();
  await bindPromptingToolbar();
  const meta = await loadPromptMetaSettings();

  const guidanceMount = document.getElementById(
    'settingsFlaticonIconGuidanceMount',
  );
  if (guidanceMount) {
    guidanceMount.replaceChildren();
    let enabled = meta.flaticonIconGuidanceEnabled;
    const { row, input } = createSettingsToggleRow(
      'Require Flaticon interface icons',
      {
        id: 'settingsFlaticonIconGuidanceEnabled',
        checked: enabled,
        searchKey: 'agents.prompting.interfaceIcons',
        description:
          'Tells agents never to use emoji as icons and to source icons from @flaticon/flaticon-uicons.',
        onChange: (checked) => {
          void (async () => {
            input.disabled = true;
            try {
              await savePromptMetaSettings({
                flaticonIconGuidanceEnabled: checked,
              });
              enabled = checked;
              schedulePromptTokenEstimateRefresh();
              setStatus(
                'ok',
                checked
                  ? 'Flaticon icon guidance enabled'
                  : 'Flaticon icon guidance disabled',
              );
            } catch {
              await savePromptMetaSettings({
                flaticonIconGuidanceEnabled: enabled,
              }).catch(() => undefined);
              input.checked = enabled;
              schedulePromptTokenEstimateRefresh();
              setStatus('err', 'Could not save Flaticon icon guidance');
            } finally {
              input.disabled = false;
            }
          })();
        },
      },
    );
    guidanceMount.appendChild(row);
  }

  await renderPromptPartsPanel(meta.activePromptProfile, meta.activePromptConfigId);
  schedulePromptTokenEstimateRefresh();
}

async function renderAgentCenterSection(): Promise<void> {
  const generation = beginAsyncSectionRender('agent-center');
  await renderAgentCenterPanel(document.getElementById('settingsAgentCenterBody'));
  if (isAsyncSectionRenderStale('agent-center', generation)) return;

  const basePromptPanel = document.getElementById('settingsBasePromptPanel');
  if (basePromptPanel instanceof HTMLDetailsElement && basePromptPanel.open) {
    await renderAgentCenterBasePrompts();
    if (isAsyncSectionRenderStale('agent-center', generation)) return;
  } else {
    ensureBasePromptPanelLazyLoad();
  }
}

let basePromptLazyLoadBound = false;

/** Load base prompt editors the first time the disclosure opens. */
function ensureBasePromptPanelLazyLoad(): void {
  if (basePromptLazyLoadBound) return;
  const panel = document.getElementById('settingsBasePromptPanel');
  if (!(panel instanceof HTMLDetailsElement)) return;
  basePromptLazyLoadBound = true;
  panel.addEventListener('toggle', () => {
    if (!panel.open) return;
    void renderAgentCenterBasePrompts();
  });
}

async function renderModelRoutingSettingsSection(): Promise<void> {
  const mount = clearMount('settingsModelRoutingBody');
  if (!mount) return;
  const generation = beginAsyncSectionRender('model-routing');
  await renderModelRoutingSection(mount);
  if (isAsyncSectionRenderStale('model-routing', generation)) return;
}

async function renderThinkingSettingsSectionWrapper(): Promise<void> {
  const mount = document.getElementById('settingsThinkingBody');
  if (!mount) return;
  const generation = beginAsyncSectionRender('thinking');
  await renderThinkingSettingsSection(mount);
  if (isAsyncSectionRenderStale('thinking', generation)) return;
}

async function renderSamplerSettingsSectionWrapper(): Promise<void> {
  const mount = clearMount('settingsSamplerBody');
  if (!mount) return;
  const generation = beginAsyncSectionRender('sampler');
  await renderSamplerSettingsSection(mount);
  if (isAsyncSectionRenderStale('sampler', generation)) return;
}

async function renderSearchSettingsSectionWrapper(): Promise<void> {
  const mount = clearMount('settingsSearchBody');
  if (!mount) return;
  const generation = beginAsyncSectionRender('search');
  await renderSearchSettingsSection(mount);
  if (isAsyncSectionRenderStale('search', generation)) return;
}

async function renderDeepResearchSettingsSectionWrapper(): Promise<void> {
  const mount = clearMount('settingsDeepResearchBody');
  if (!mount) return;
  const generation = beginAsyncSectionRender('deep-research');
  await renderDeepResearchSettingsSection(mount);
  if (isAsyncSectionRenderStale('deep-research', generation)) return;
}

async function renderServersSettingsSectionWrapper(): Promise<void> {
  const mount = clearMount('settingsServersBody');
  if (!mount) return;
  const generation = beginAsyncSectionRender('servers');
  await renderServersSettingsSection(mount);
  if (isAsyncSectionRenderStale('servers', generation)) return;
}

// ── Tools ────────────────────────────────────────────────────────────────────

async function renderAutopilotSection(): Promise<void> {
  const mount = clearMount('settingsAutopilotBody');
  if (!mount) return;
  const generation = beginAsyncSectionRender('autopilot');
  await loadAutopilotMeta();
  if (isAsyncSectionRenderStale('autopilot', generation)) return;
  await renderAutopilotSettingsSection(mount);
}

/** Generation upstream timeouts (Settings → Agents → Watchdog). */
async function appendGenerationTimeoutsSection(
  mount: HTMLElement,
  options?: { emphasis?: boolean },
): Promise<void> {
  await loadChatMeta();
  const chatMeta = getChatMetaSync();

  const timeoutSection = appendSettingsGroup(
    mount,
    'Generation timeouts',
    'Server-side limits while streaming from the model. Idle timeout resets when new tokens arrive. Set either limit to 0 to turn it off. Applies to the next generation; no restart needed.',
    'agents.watchdog.generation',
    options?.emphasis ? { emphasis: true } : undefined,
  );

  const syncTimeoutInputsEnabled = (enabled: boolean): void => {
    idleInput.disabled = !enabled;
    maxInput.disabled = !enabled;
  };

  const { row: enabledRow, input: enabledToggle } = createSettingsToggleRow(
    'Enable generation timeouts',
    {
      checked: isGenerationTimeoutEnabled(chatMeta),
      description: 'When off, generations are not cut off by idle or max-duration limits.',
      searchKey: 'agents.watchdog.generation.enabled',
    },
  );
  timeoutSection.appendChild(enabledRow);

  const idleInput = document.createElement('input');
  idleInput.type = 'number';
  idleInput.className = 'settings-input';
  idleInput.min = '0';
  idleInput.step = '1';
  idleInput.value = String(generationTimeoutMsToMinutes(chatMeta.generationIdleTimeoutMs));
  idleInput.setAttribute(
    'aria-label',
    'Minutes without model stream data before aborting (0 disables)',
  );
  timeoutSection.appendChild(
    createSettingsInputRow('Idle timeout (minutes)', { input: idleInput }).row,
  );

  const maxInput = document.createElement('input');
  maxInput.type = 'number';
  maxInput.className = 'settings-input';
  maxInput.min = '0';
  maxInput.step = '1';
  maxInput.value = String(generationTimeoutMsToMinutes(chatMeta.generationMaxDurationMs));
  maxInput.setAttribute('aria-label', 'Maximum wall-clock minutes per generation (0 disables)');
  timeoutSection.appendChild(
    createSettingsInputRow('Max duration (minutes)', { input: maxInput }).row,
  );

  syncTimeoutInputsEnabled(enabledToggle.checked);

  enabledToggle.addEventListener('change', () => {
    void (async () => {
      if (enabledToggle.checked) {
        const current = getChatMetaSync();
        const idleMs =
          current.generationIdleTimeoutMs > 0
            ? current.generationIdleTimeoutMs
            : DEFAULT_GENERATION_IDLE_TIMEOUT_MS;
        const maxMs =
          current.generationMaxDurationMs > 0
            ? current.generationMaxDurationMs
            : DEFAULT_GENERATION_MAX_DURATION_MS;
        idleInput.value = String(generationTimeoutMsToMinutes(idleMs));
        maxInput.value = String(generationTimeoutMsToMinutes(maxMs));
        syncTimeoutInputsEnabled(true);
        try {
          await saveChatMeta({
            generationIdleTimeoutMs: idleMs,
            generationMaxDurationMs: maxMs,
          });
          setStatus('ok', 'Generation timeouts enabled');
        } catch {
          setStatus('err', 'Could not save generation timeouts');
        }
        return;
      }

      syncTimeoutInputsEnabled(false);
      try {
        await saveChatMeta({
          generationIdleTimeoutMs: 0,
          generationMaxDurationMs: 0,
        });
        setStatus('ok', 'Generation timeouts disabled');
      } catch {
        setStatus('err', 'Could not save generation timeouts');
      }
    })();
  });

  idleInput.addEventListener('change', () => {
    void (async () => {
      const minutes = Math.max(0, Math.floor(Number(idleInput.value) || 0));
      idleInput.value = String(minutes);
      const ms =
        minutes === 0 ? 0 : clampGenerationIdleTimeoutMs(generationTimeoutMinutesToMs(minutes));
      try {
        await saveChatMeta({ generationIdleTimeoutMs: ms });
        setStatus('ok', 'Generation idle timeout updated');
      } catch {
        setStatus('err', 'Could not save generation idle timeout');
      }
    })();
  });

  maxInput.addEventListener('change', () => {
    void (async () => {
      const minutes = Math.max(0, Math.floor(Number(maxInput.value) || 0));
      maxInput.value = String(minutes);
      const ms =
        minutes === 0 ? 0 : clampGenerationMaxDurationMs(generationTimeoutMinutesToMs(minutes));
      try {
        await saveChatMeta({ generationMaxDurationMs: ms });
        setStatus('ok', 'Generation max duration updated');
      } catch {
        setStatus('err', 'Could not save generation max duration');
      }
    })();
  });
}

async function renderWatchdogSection(): Promise<void> {
  const generation = beginAsyncSectionRender('watchdog');
  const mount = clearMount('settingsWatchdogBody');
  if (!mount) return;

  const shell = el('div', 'settings-general settings-general--wide');
  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');
  lead.textContent =
    'Limits that stop a generation when the model stream hangs: idle (no tokens) and max duration. Sub-agent wall-clock and crash retry live under Sub-agents — there is no heartbeat supervisor.';
  shell.appendChild(lead);

  const content = el('div', 'settings-general__content');
  shell.appendChild(content);

  await appendGenerationTimeoutsSection(content, { emphasis: true });
  if (isAsyncSectionRenderStale('watchdog', generation)) return;
  await renderAgentSupervisionSection(content, { emphasis: true });
}

let toolsSectionInitialized = false;

async function renderToolsSection(): Promise<void> {
  const generation = beginAsyncSectionRender('tools');
  const mount = clearMount('settingsToolsBody');
  if (!mount) return;

  const shell = el('div', 'settings-general');
  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');
  lead.append(
    'Permissions for built-in, plugin, and MCP tools, plus the session cache. Servers are added under ',
    linkToSettingsSection('MCP', 'mcp'),
    '. Browser automation lives under ',
    linkToSettingsSection('Browser', 'browser'),
    '. Slash commands live under ',
    linkToSettingsSection('Skills', 'skills'),
    '. Web search keys live under ',
    linkToSettingsSection('Search', 'search'),
    '.',
  );
  shell.appendChild(lead);

  appendSettingsOfflineHint(shell, 'Some tools need Minnow running locally. Open or restart the app.', {
    id: 'settingsToolsServerBanner',
    hidden: true,
  });
  appendSettingsOfflineHint(
    shell,
    'Browser tools only work in the Minnow desktop app window, not in a separate browser tab.',
    { id: 'settingsToolsPreviewBanner', hidden: true },
  );

  const content = el('div', 'settings-general__content');
  shell.appendChild(content);

  const structuredGroup = appendSettingsGroup(
    content,
    'Structured tool arguments',
    'Optional JSON Schema on tool turns when the active provider supports it.',
    'integrations.tools',
    { emphasis: true },
  );
  await appendToolCallDefaults(structuredGroup);
  if (isAsyncSectionRenderStale('tools', generation)) return;

  if (!isToolConfigReadyForSettingsUi()) {
    await loadToolConfigForSettingsUi();
    if (isAsyncSectionRenderStale('tools', generation)) return;
  }

  const loadingGroup = appendSettingsGroup(
    content,
    'Tool loading',
    'Save context by loading additional tool schemas when the model searches for them. Applies to new chat turns and agent attempts.',
    'integrations.tools.lazyLoading',
    { emphasis: true },
  );
  const { row: loadingToggle, input: loadingCheckbox } = createSettingsToggleRow(
    'Load tool schemas on demand',
    { id: 'settingsLazyToolsEnabled', searchKey: 'integrations.tools.lazyLoading' },
  );
  loadingCheckbox.checked = getToolConfig().lazyTools !== false;
  loadingCheckbox.addEventListener('change', () => {
    const config = getToolConfig();
    config.lazyTools = loadingCheckbox.checked;
    saveToolConfig(config);
  });
  loadingGroup.appendChild(loadingToggle);

  const cacheGroup = appendSettingsGroup(
    content,
    'Session cache',
    'Speed up repeated read-only tool calls for the current workspace session.',
    'integrations.tools.cache',
    { emphasis: true },
  );

  const { row: cacheToggle, input: cacheCheckbox } = createSettingsToggleRow(
    'Cache repeated read-only tool results in this session',
    {
      id: 'settingsToolCacheEnabled',
      searchKey: 'integrations.tools.cache',
    },
  );
  cacheGroup.appendChild(cacheToggle);
  cacheGroup.appendChild(
    el(
      'p',
      'settings-field-hint',
      'Applies to duplicate read_file and similar calls until the workspace changes or a write invalidates the path. Cleared on workspace switch.',
    ),
  );

  const outputCapGroup = appendSettingsGroup(
    content,
    'Tool result size',
    'How much text each file read, search, or shell command may return to the model.',
    'integrations.tools.outputCap',
    { emphasis: true },
  );
  const { row: outputCapToggle, input: outputCapCheckbox } = createSettingsToggleRow(
    'Limit tool result size',
    {
      id: 'settingsToolOutputCapEnabled',
      searchKey: 'integrations.tools.outputCap',
    },
  );
  outputCapGroup.appendChild(outputCapToggle);
  const { row: maxCharsRow, input: maxCharsInput } = createSettingsInputRow(
    'Maximum characters per result',
    {
      id: 'settingsToolOutputCapMaxChars',
      searchKey: 'integrations.tools.outputCap.maxChars',
      type: 'number',
      min: String(TOOL_OUTPUT_MAX_CHARS_MIN),
      max: String(TOOL_OUTPUT_MAX_CHARS_MAX),
      step: '1000',
    },
  );
  outputCapGroup.appendChild(maxCharsRow);
  outputCapGroup.appendChild(
    el(
      'p',
      'settings-field-hint',
      'Caps how much text each file read, search, or shell command returns to the model. This does not compress chat history — that is Settings → Agents → Context policy.',
    ),
  );

  const catalog = appendSettingsGroup(
    content,
    'Tool catalog',
    'Each tool can be off, ask before run, or full permission. File and git tools need Minnow running locally. Plugin tools appear at the bottom when Minnow is running.',
    'integrations.tools',
    { emphasis: true },
  );

  const list = document.createElement('div');
  list.id = 'settingsToolsList';
  list.className = 'tools-list settings-tools-list';

  catalog.appendChild(
    createSettingsActionsRow(
      [
        {
          id: 'settingsToolsAllFull',
          label: 'All full permissions',
          variant: 'danger',
          onClick: () => {
            void (async () => {
              const ok = await appConfirm(
                'Grant full permission to all tools?\n\nEvery built-in tool will run without the approval prompt. Paths outside the workspace stay blocked unless you enable full disk access under Settings → General → Filesystem access.\n\nOnly use this if you accept that risk.',
              );
              if (!ok) return;
              try {
                await setAllBuiltInToolPermissions('full', list);
                setStatus('ok', 'All tools set to full permission');
              } catch {
                setStatus('err', 'Could not save. Open or restart Minnow and try again.');
              }
            })();
          },
        },
        {
          id: 'settingsToolsResetDefaults',
          label: 'Reset to defaults',
          onClick: () => {
            void (async () => {
              const ok = await appConfirm(
                'Reset all tool permissions to defaults?\n\nBuilt-in tools will return to factory on/off and ask settings.',
              );
              if (!ok) return;
              try {
                await resetBuiltInToolPermissionsToDefaults(list);
                setStatus('ok', 'Tool permissions reset to defaults');
              } catch {
                setStatus('err', 'Could not save. Open or restart Minnow and try again.');
              }
            })();
          },
        },
      ],
      { searchKey: 'integrations.tools.bulk', className: 'settings-tools-toolbar' },
    ),
  );
  catalog.appendChild(list);

  fillToolsSection('settingsToolsList', { variant: 'settings' });
  const { appendPluginToolsToList } = await import('./settings-plugins');
  await appendPluginToolsToList('settingsToolsList');
  const { appendMcpToolsToList } = await import('./settings-mcp-tools');
  await appendMcpToolsToList('settingsToolsList');
  if (isAsyncSectionRenderStale('tools', generation)) return;

  if (!toolsSectionInitialized) {
    toolsSectionInitialized = true;
    registerToolHandlers();
  }

  const persistToolCache = (): void => {
    const config = getToolConfig();
    config.toolCache = { enabled: cacheCheckbox.checked };
    saveToolConfig(config);
  };
  cacheCheckbox.addEventListener('change', persistToolCache);

  const persistToolOutput = (): void => {
    const config = getToolConfig();
    const parsed = Number(maxCharsInput.value);
    config.toolOutput = normalizeToolOutputConfig({
      enabled: outputCapCheckbox.checked,
      maxChars: Number.isFinite(parsed) ? parsed : DEFAULT_MAX_OUTPUT_CHARS,
    });
    maxCharsInput.value = String(config.toolOutput.maxChars);
    maxCharsInput.disabled = !outputCapCheckbox.checked;
    saveToolConfig(config);
  };
  outputCapCheckbox.addEventListener('change', persistToolOutput);
  maxCharsInput.addEventListener('change', persistToolOutput);

  const config = getToolConfig();
  cacheCheckbox.checked = config.toolCache?.enabled !== false;
  const toolOutput = normalizeToolOutputConfig(config.toolOutput);
  outputCapCheckbox.checked = toolOutput.enabled;
  maxCharsInput.value = String(toolOutput.maxChars);
  maxCharsInput.disabled = !toolOutput.enabled;
  loadToolConfigIntoDrawer(list);

  document.getElementById('settingsToolsServerBanner')?.classList.toggle(
    'hidden',
    isLocalServerAvailable(),
  );

  appendSettingsCrosslinks(content, [
    { label: 'MCP servers', sectionId: 'mcp' },
    { label: 'Browser automation', sectionId: 'browser' },
    { label: 'Skills catalog', sectionId: 'skills' },
    { label: 'Web search', sectionId: 'search' },
  ]);
}

/** Test fixture server — hidden from settings UI. */
const MCP_SETTINGS_HIDDEN_IDS = new Set(['fixture']);

// ── MCP ──────────────────────────────────────────────────────────────────────

function sortMcpServersForDisplay(
  servers: McpServerSummary[],
): McpServerSummary[] {
  return [...servers]
    .filter((s) => !MCP_SETTINGS_HIDDEN_IDS.has(s.id))
    .sort((a, b) => {
      if (a.id === 'context7') return -1;
      if (b.id === 'context7') return 1;
      return a.label.localeCompare(b.label);
    });
}

function createMcpSettingsRow(
  server: McpServerSummary,
  options?: { hasContext7ApiKey?: boolean },
): HTMLElement {
  const row = document.createElement('article');
  row.className = 'settings-mcp-row';
  row.setAttribute('role', 'listitem');
  row.dataset.serverId = server.id;

  const head = document.createElement('div');
  head.className = 'settings-mcp-row-head';

  const label = document.createElement('div');
  label.className = 'settings-mcp-toggle';
  const { root: switchRoot, input: checkbox } = createSettingsSwitch({
    checked: server.enabled,
    ariaLabel: `${server.enabled ? 'Disable' : 'Enable'} ${server.label}`,
  });
  checkbox.dataset.mcpToggle = server.id;

  const title = document.createElement('span');
  title.className = 'settings-mcp-name';
  title.textContent = server.label;
  label.append(switchRoot, title);
  head.append(label);

  if (server.builtin) {
    const badge = document.createElement('span');
    badge.className = 'settings-mcp-badge settings-mcp-badge--builtin';
    badge.textContent = 'Built-in';
    head.append(badge);
  } else {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'settings-inline-btn settings-mcp-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.setAttribute('aria-label', `Remove ${server.label}`);
    removeBtn.dataset.mcpRemove = server.id;
    head.append(removeBtn);
  }

  row.append(head);

  const detail = document.createElement('div');
  detail.className = 'settings-mcp-detail';

  if (server.description) {
    const desc = document.createElement('p');
    desc.className = 'settings-mcp-desc';
    desc.textContent = server.description;
    detail.append(desc);
  }

  const status = document.createElement('span');
  status.className = `settings-mcp-status ${
    server.connected ? 'settings-mcp-status--ok' : 'settings-mcp-status--idle'
  }`;
  status.setAttribute(
    'aria-label',
    server.connected ? 'Server reachable' : 'Server not reachable',
  );
  const statusDot = document.createElement('span');
  statusDot.className = 'settings-mcp-status-dot';
  statusDot.setAttribute('aria-hidden', 'true');
  const statusText = document.createElement('span');
  statusText.className = 'settings-mcp-status-text';
  statusText.textContent = server.connected ? 'Connected' : 'Not connected';
  status.append(statusDot, statusText);
  detail.append(status);
  if (server.authorizationUrl) {
    const signIn = document.createElement('a');
    signIn.href = server.authorizationUrl;
    signIn.target = '_blank';
    signIn.rel = 'noopener noreferrer';
    signIn.className = 'settings-action-btn';
    signIn.textContent = 'Sign in';
    // target=_blank opens an Electron child window; OAuth belongs in the user's default browser.
    signIn.addEventListener('click', (event) => {
      if (!window.minnow?.app?.openExternal) return;
      event.preventDefault();
      void window.minnow.app.openExternal(signIn.href);
    });
    detail.append(signIn);
    statusText.textContent = 'Sign-in required';
  } else if (server.error) {
    detail.append(el('p', 'field-hint', server.error));
  }
  if (server.enabled && !server.connected) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'settings-inline-btn';
    retry.textContent = 'Refresh connection';
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      await refreshMcpToolCache();
      await renderMcpSection();
    });
    detail.append(retry);
  }

  if (server.id === 'context7') {
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.id = 'settingsMcpContext7ApiKey';
    keyInput.className = 'settings-input';
    keyInput.autocomplete = 'off';
    keyInput.placeholder = options?.hasContext7ApiKey
      ? 'Leave blank to keep current key'
      : 'Optional — get one at context7.com';

    const keyHint = document.createElement('p');
    keyHint.className = 'settings-mcp-hint';
    keyHint.textContent = options?.hasContext7ApiKey
      ? 'A key is saved on the server (not shown here). Encrypted at rest under ~/.minnow/mcp/secrets.json.'
      : 'No API key saved yet. Required for live library docs from Context7.';

    detail.appendChild(
      createSettingsInputRow('Context7 API key', {
        input: keyInput,
        description: keyHint.textContent,
      }).row,
    );
    detail.appendChild(
      createSettingsActionsRow([
        {
          label: 'Save key',
          className: 'settings-inline-btn',
          onClick: () => {
            void (async () => {
              const value = keyInput.value.trim();
              if (!value) {
                if (!options?.hasContext7ApiKey) {
                  setStatus('err', 'Enter a Context7 API key');
                  return;
                }
                setStatus('ok', 'Context7 API key unchanged');
                return;
              }
              const result = await updateMcpSecrets({ context7ApiKey: value });
              if (result.ok === false) {
                setStatus('err', result.error);
                return;
              }
              const { flags } = result;
              keyInput.value = '';
              keyInput.placeholder = flags.hasContext7ApiKey
                ? 'Leave blank to keep current key'
                : 'Optional — get one at context7.com';
              keyHint.textContent = flags.hasContext7ApiKey
                ? 'A key is saved on the server (not shown here). Encrypted at rest under ~/.minnow/mcp/secrets.json.'
                : 'No API key saved yet. Required for live library docs from Context7.';
              setStatus('ok', 'Context7 API key saved');
              await renderMcpSection();
            })();
          },
        },
      ]),
    );
  }

  row.append(detail);
  return row;
}

let mcpToggleHandlerBound = false;
let mcpAddFormBound = false;
let mcpSettingsShellReady = false;
let mcpSignInRefreshBound = false;

/** Build the add-server disclosure form (mounted once inside the MCP settings shell). */
function buildMcpAddPanel(): HTMLDetailsElement {
  const panel = document.createElement('details');
  panel.id = 'settingsMcpAddPanel';
  panel.className = 'settings-mcp-add-panel hidden';

  const summary = document.createElement('summary');
  summary.className = 'settings-mcp-add-summary';
  summary.textContent = 'Add MCP server';
  panel.appendChild(summary);

  const form = document.createElement('form');
  form.id = 'settingsMcpAddForm';
  form.className = 'settings-mcp-form';
  form.noValidate = true;

  const configField = el('div', 'field');
  configField.append(
    Object.assign(document.createElement('label'), {
      htmlFor: 'settingsMcpAddJson', textContent: 'MCP configuration',
    }),
    Object.assign(document.createElement('textarea'), {
      id: 'settingsMcpAddJson', name: 'config', rows: 10, spellcheck: false,
      placeholder: JSON.stringify({ mcpServers: { 'cloudflare-api': { url: 'https://mcp.cloudflare.com/mcp' } } }, null, 2),
    }),
    el('p', 'field-hint', 'Paste a mcpServers JSON configuration. Added servers are approved for agent use. Sign in with the provider if required.'),
  );

  const errEl = el('p', 'settings-mcp-form-error hidden');
  errEl.id = 'settingsMcpAddError';
  errEl.setAttribute('role', 'alert');

  const actions = el('div', 'settings-mcp-form-actions');
  const submitBtn = Object.assign(document.createElement('button'), {
    type: 'submit',
    className: 'settings-action-btn',
    textContent: 'Add servers',
  });
  const resetBtn = Object.assign(document.createElement('button'), {
    type: 'button',
    id: 'settingsMcpAddReset',
    className: 'settings-inline-btn',
    textContent: 'Clear form',
  });
  actions.append(submitBtn, resetBtn);

  form.append(configField, errEl, actions);
  panel.appendChild(form);
  return panel;
}

/** Mount the MCP settings shell once (emphasis-panel layout like Browser / Servers). */
function ensureMcpSettingsShell(mount: HTMLElement): {
  listEl: HTMLElement;
  offlineEl: HTMLElement;
  addPanel: HTMLDetailsElement;
} {
  if (mcpSettingsShellReady) {
    return {
      listEl: document.getElementById('settingsMcpServerList')!,
      offlineEl: document.getElementById('settingsMcpOffline')!,
      addPanel: document.getElementById('settingsMcpAddPanel') as HTMLDetailsElement,
    };
  }

  mount.replaceChildren();

  const shell = el('div', 'settings-general');
  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');
  lead.textContent = 'Connect tools by pasting a standard MCP configuration. Added servers are approved for your agents. Provider sign-in appears here when needed.';
  shell.appendChild(lead);

  const offlineEl = appendSettingsOfflineHint(
    shell,
    'Open Minnow to load, toggle, and add MCP integrations.',
    { id: 'settingsMcpOffline', searchKey: 'integrations.mcp', hidden: true },
  );
  offlineEl.classList.add('settings-mcp-offline');

  const content = el('div', 'settings-general__content');
  shell.appendChild(content);

  const catalog = appendSettingsGroup(
    content,
    'Configured servers',
    'Built-in servers ship with Minnow. Custom entries persist in ~/.minnow/mcp.json.',
    'integrations.mcp',
    { emphasis: true },
  );

  const listEl = el('div', 'settings-mcp-list');
  listEl.id = 'settingsMcpServerList';
  listEl.setAttribute('role', 'list');
  listEl.setAttribute('aria-label', 'Configured MCP servers');
  catalog.appendChild(listEl);

  const addPanel = buildMcpAddPanel();
  catalog.appendChild(addPanel);

  appendSettingsCrosslinks(content, [
    { label: 'Language servers', sectionId: 'lsp' },
    { label: 'Editor', sectionId: 'editor' },
    { label: 'Tool permissions', sectionId: 'tools' },
  ]);

  mcpSettingsShellReady = true;
  bindMcpAddForm();

  return { listEl, offlineEl, addPanel };
}

function clearMcpAddForm(): void {
  const form = document.getElementById('settingsMcpAddForm') as HTMLFormElement | null;
  form?.reset();
  const enabled = document.getElementById('settingsMcpAddEnabled') as HTMLInputElement | null;
  if (enabled) enabled.checked = true;
  const err = document.getElementById('settingsMcpAddError');
  err?.classList.add('hidden');
  if (err) err.textContent = '';
}

function bindMcpAddForm(): void {
  if (mcpAddFormBound) return;
  mcpAddFormBound = true;

  const form = document.getElementById('settingsMcpAddForm') as HTMLFormElement | null;
  const errEl = document.getElementById('settingsMcpAddError');
  const resetBtn = document.getElementById('settingsMcpAddReset');

  resetBtn?.addEventListener('click', () => clearMcpAddForm());

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      const input = document.getElementById('settingsMcpAddJson') as HTMLTextAreaElement;
      let payload: unknown;
      try { payload = JSON.parse(input.value); }
      catch {
        if (errEl) { errEl.textContent = 'Enter valid JSON with a mcpServers object.'; errEl.classList.remove('hidden'); }
        return;
      }
      const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (button) { button.disabled = true; button.textContent = 'Adding…'; }
      const result = await importMcpServers(payload);
      if (button) { button.disabled = false; button.textContent = 'Add servers'; }

      if (result.ok === false) {
        const errMsg = result.error;
        if (errEl) {
          errEl.textContent = errMsg;
          errEl.classList.remove('hidden');
        }
        setStatus('err', errMsg);
        return;
      }

      if (errEl) errEl.classList.add('hidden');
      clearMcpAddForm();
      setStatus('ok', 'MCP servers added');
      await renderMcpSection();
    })();
  });
}

async function renderMcpSection(): Promise<void> {
  const mount = document.getElementById('settingsMcpBody');
  if (!mount) return;
  if (!mcpSignInRefreshBound) {
    mcpSignInRefreshBound = true;
    window.addEventListener('focus', () => {
      if (mount.isConnected && mount.getClientRects().length) {
        void refreshMcpToolCache().then(() => renderMcpSection());
      }
    });
  }

  const { listEl, offlineEl, addPanel } = ensureMcpSettingsShell(mount);

  const online = isLocalServerAvailable();
  offlineEl.classList.toggle('hidden', online);
  addPanel.classList.toggle('hidden', !online);

  if (!online) {
    listEl.replaceChildren();
    return;
  }

  const servers = await fetchMcpServers();
  const secretFlags = online ? await fetchMcpSecrets() : null;
  if (servers === null) {
    listEl.replaceChildren();
    listEl.appendChild(
      el('p', 'settings-field-hint', 'Could not load MCP servers.'),
    );
    return;
  }

  const visible = sortMcpServersForDisplay(servers);
  listEl.replaceChildren();
  if (visible.length === 0) {
    listEl.appendChild(
      el('p', 'settings-field-hint', 'No MCP servers in ~/.minnow/mcp.json.'),
    );
    return;
  }

  for (const server of visible) {
    listEl.appendChild(
      createMcpSettingsRow(server, {
        hasContext7ApiKey: secretFlags?.hasContext7ApiKey === true,
      }),
    );
  }

  if (!mcpToggleHandlerBound) {
    mcpToggleHandlerBound = true;
    listEl.addEventListener('change', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      const serverId = target.dataset.mcpToggle;
      if (!serverId) return;

      const ok = await setMcpServerEnabled(serverId, target.checked);
      if (ok) {
        setStatus(
          'ok',
          target.checked ? `${serverId} enabled` : `${serverId} disabled`,
        );
        await renderMcpSection();
        return;
      }
      target.checked = !target.checked;
      setStatus('err', 'Could not update MCP integration. Open or restart Minnow.');
    });

    listEl.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) return;
      const serverId = target.dataset.mcpRemove;
      if (!serverId) return;

      void (async () => {
        if (
          !(await appConfirm(`Remove MCP server "${serverId}"?`, {
            confirmLabel: 'Remove',
            danger: true,
          }))
        ) {
          return;
        }
        const ok = await deleteMcpServer(serverId);
        if (ok) {
          setStatus('ok', `Removed ${serverId}`);
          await renderMcpSection();
          return;
        }
        setStatus('err', 'Could not remove MCP server');
      })();
    });
  }
}

// ── Other sections ───────────────────────────────────────────────────────────

async function renderAgentPacksSection(): Promise<void> {
  const mount = clearMount('settingsAgentPacksBody');
  if (!mount) return;

  const shell = el('div', 'settings-general');
  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');
  lead.append(
    'Install drop-in bundles of work agents with prompts and tool allowlists. Pack agents merge with built-ins and appear in ',
    linkToSettingsSection('Agents', 'agent-center'),
    '. Per-agent models live under ',
    linkToSettingsSection('Routing', 'model-routing'),
    '.',
  );
  shell.appendChild(lead);

  const content = el('div', 'settings-general__content');
  shell.appendChild(content);
  await renderAgentPacksSettingsSection(content);
}

async function renderSkillsSection(): Promise<void> {
  const mount = clearMount('settingsSkillsBody');
  if (!mount) return;

  const shell = el('div', 'settings-general');
  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');
  lead.append(
    'Slash commands the agent can load with /skill-name. Tool permissions live under ',
    linkToSettingsSection('Tools', 'tools'),
    '. Browser automation lives under ',
    linkToSettingsSection('Browser', 'browser'),
    '.',
  );
  shell.appendChild(lead);

  const content = el('div', 'settings-general__content');
  shell.appendChild(content);

  const catalog = appendSettingsGroup(
    content,
    'Skills catalog',
    'Built-in skills ship with Minnow. Custom skills live under ~/.minnow/skills/ when Minnow is running locally.',
    'integrations.skills',
    { emphasis: true },
  );
  await renderSkillsSettingsSection(catalog);

  appendSettingsCrosslinks(content, [
    { label: 'Skills Library', sectionId: 'skills-library' },
    { label: 'Tool permissions', sectionId: 'tools' },
    { label: 'Browser automation', sectionId: 'browser' },
  ]);
}

async function renderSkillsLibrarySection(): Promise<void> {
  const mount = clearMount('settingsSkillsLibraryBody');
  if (!mount) return;

  const shell = el('div', 'settings-general');
  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');
  lead.append(
    'Browse curated third-party SKILL.md packs, install skills into ',
    document.createElement('code'),
    ', or add from a GitHub URL. Enable/disable installed skills in ',
    linkToSettingsSection('Skills catalog', 'skills'),
    '.',
  );
  (lead.querySelector('code') as HTMLElement).textContent = '~/.minnow/skills/';
  shell.appendChild(lead);

  const content = el('div', 'settings-general__content');
  shell.appendChild(content);

  const library = appendSettingsGroup(
    content,
    'Curated packs',
    'Matt Pocock, Addy Osmani, Superpowers, last30days, and Browserbase ship offline indexes for browse.',
    'integrations.skills-library',
    { emphasis: true },
  );
  await renderSkillsLibrarySettingsSection(library);

  appendSettingsCrosslinks(content, [
    { label: 'Skills catalog', sectionId: 'skills' },
    { label: 'Tool permissions', sectionId: 'tools' },
  ]);
}

async function renderBrowserSection(): Promise<void> {
  const mount = clearMount('settingsBrowserBody');
  if (!mount) return;
  const generation = beginAsyncSectionRender('browser');
  await renderBrowserSettingsSection(mount);
  if (isAsyncSectionRenderStale('browser', generation)) return;
}

async function renderWebhooksSection(): Promise<void> {
  const mount = clearMount('settingsWebhooksBody');
  if (!mount) return;
  await renderWebhooksSettingsSection(mount);
}

async function renderRulesSection(): Promise<void> {
  const mount = clearMount('settingsRulesBody');
  if (!mount) return;

  const shell = el('div', 'settings-general');
  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');
  lead.append(
    'Standing instructions added to every parent chat send, after the built-in system prompt. Does not apply to sub-agents. Mode and agent prompts live under ',
    linkToSettingsSection('Agents', 'agent-center'),
    '.',
  );
  shell.appendChild(lead);

  const content = el('div', 'settings-general__content');
  shell.appendChild(content);
  await renderRulesSettingsSection(content, setStatus);
}

async function renderInjectionSection(): Promise<void> {
  const mount = clearMount('settingsInjectionBody');
  if (!mount) return;

  await renderInjectionSettingsSection(mount, setStatus);
}

async function renderAppearanceSection(): Promise<void> {
  const mount = clearMount('settingsAppearanceBody');
  if (!mount) return;
  renderAppearanceSettingsSection(mount);
}

async function renderAppsSection(): Promise<void> {
  const mount = clearMount('settingsAppsBody');
  if (!mount) return;
  renderAppsSettingsSection(mount);
}

async function renderIssuesSettingsPanel(): Promise<void> {
  const mount = clearMount('settingsIssuesBody');
  if (!mount) return;
  renderIssuesSettingsSection(mount);
}

// ── Refresh ──────────────────────────────────────────────────────────────────

/** Load or refresh one settings section from live APIs. */
export async function refreshSettingsSection(
  section: SettingsSectionId,
): Promise<void> {
  switch (section) {
    case 'general':
      await renderGeneralSection();
      break;
    case 'notifications':
      await renderNotificationsSection();
      break;
    case 'apps':
      await renderAppsSection();
      break;
    case 'issues':
      await renderIssuesSettingsPanel();
      break;
    case 'appearance':
      await renderAppearanceSection();
      break;
    case 'audio':
      await renderAudioSection();
      break;
    case 'about':
      await renderAboutSettingsSection();
      break;
    case 'diagnostics':
      await renderDiagnosticsSettingsSection();
      break;
    case 'board-testing':
      if (!isBoardTestingSettingsVisible()) {
        break;
      }
      await renderBoardTestingSettingsSection();
      break;
    case 'capability-matrix':
      await renderCapabilityMatrixSettingsSection();
      break;
    case 'providers':
      refreshProvidersBanner();
      await listProviders();
      await renderProvidersSettingsSection();
      break;
    case 'usage':
      await renderUsageSettingsSection();
      break;
    case 'model-routing':
      await renderModelRoutingSettingsSection();
      break;
    case 'sampler':
      await renderSamplerSettingsSectionWrapper();
      break;
    case 'thinking':
      await renderThinkingSettingsSectionWrapper();
      break;
    case 'agent-center':
      await renderAgentCenterSection();
      break;
    case 'prompting':
    case 'modes':
    case 'work-agents':
    case 'sub-agents':
      await renderAgentCenterSection();
      break;
    case 'rules':
      await renderRulesSection();
      break;
    case 'injection':
      await renderInjectionSection();
      break;
    case 'agent-packs':
      await renderAgentPacksSection();
      break;
    case 'autopilot':
      await renderAutopilotSection();
      break;
    case 'watchdog':
      await renderWatchdogSection();
      break;
    case 'search':
      await renderSearchSettingsSectionWrapper();
      break;
    case 'deep-research':
      await renderDeepResearchSettingsSectionWrapper();
      break;
    case 'servers':
      await renderServersSettingsSectionWrapper();
      break;
    case 'tools':
      await renderToolsSection();
      break;
    case 'browser':
      await renderBrowserSection();
      break;
    case 'mcp-hub':
      await renderMcpHubSettingsSection();
      break;
    case 'mcp':
      await renderMcpSection();
      break;
    case 'lsp':
      await renderLspSection();
      break;
    case 'editor':
      await renderEditorSection();
      break;
    case 'skills':
      await renderSkillsSection();
      break;
    case 'skills-library':
      await renderSkillsLibrarySection();
      break;
    case 'webhooks':
      await renderWebhooksSection();
      break;
    default:
      break;
  }
}

export { beginAsyncSectionRender, isAsyncSectionRenderStale } from './settings-section-render-guard';
