import '../styles/settings-general.css';
import '../styles/settings-agent-center.css';

/**
 * Settings → Agents. One agent runs every chat, sub-agent and board task, so
 * this page edits that agent: its prompts (base, tool usage, local-model
 * guidance), the /ask, /plan and /debug skill prompts, the Boards prompt, and
 * sub-agent limits, and the global permission level.
 */

import {
  loadSubAgentConfig,
  patchSubAgentUserOverrides,
} from '../agents/sub-agent-config';
import type { ContextEnforcementPolicy } from '../chat/context-budget';
import { createIcon, type IconName } from './icon';
import { isServerStorageMode } from '../config/storage-mode';
import { appendSettingsGroup, linkToSettingsSection } from './settings-layout';
import { renderPermissionSettings } from './settings-filesystem';
import {
  appendSettingsOfflineHint,
  createSettingsKvList,
  createSettingsRadioRow,
  createSettingsSelectRow,
} from './settings-controls';
import { msToSeconds, secondsToMs } from './settings-duration';
import {
  createGlobalContextPolicySelect,
  mountCompactionKnobs,
  mountPromptFileEditor,
} from './settings-entity-editor';
import {
  appendAgentCenterSection,
  openAgentCenterLightbox,
} from './settings-agent-center-lightbox';
import {
  loadPromptMetaSettings,
  parseLocalModelGuidance,
  savePromptMetaSettings,
  type LocalModelGuidance,
} from '../config/prompt-meta';
import type { PromptFileFamily } from '../chat/prompts/prompt-file-api';
import { loadPromptById } from '../chat/prompts/prompt-loader';
import { getAllSkillCatalog, refreshSkillCatalog } from '../skills/client';
import { mountSkillEditor } from './settings-skills';
import { schedulePromptTokenEstimateRefresh } from './settings-prompt-estimate';
import { createSettingsSwitch } from './settings-switch';
import { setStatus } from './status';

export type AgentCenterSectionId = 'prompts' | 'skills' | 'boards';

export interface AgentCenterCard {
  id: string;
  kind: AgentCenterSectionId;
  title: string;
  description: string;
  icon: IconName;
  meta?: string;
  searchKey: string;
  open: () => void;
}

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

// ── Prompt lightboxes ────────────────────────────────────────────────────────

function openPromptFileLightbox(options: {
  title: string;
  subtitle: string;
  badge: string;
  family: PromptFileFamily;
  entityId: string;
  extra?: (body: HTMLElement) => void;
}): void {
  openAgentCenterLightbox({
    title: options.title,
    subtitle: options.subtitle,
    badge: options.badge,
    render: (body) => {
      options.extra?.(body);
      appendAgentCenterSection(body, 'Prompt', (panel) => {
        mountPromptFileEditor(panel, {
          family: options.family,
          entityId: options.entityId,
          rows: 18,
        });
      });
    },
  });
}

const LOCAL_GUIDANCE_OPTIONS: { value: LocalModelGuidance; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Added for local and LAN providers (LM Studio, llama.cpp, MLX); left out for cloud models.' },
  { value: 'on', label: 'On', hint: 'Added for every model.' },
  { value: 'off', label: 'Off', hint: 'Never added.' },
];

function localGuidanceHint(value: LocalModelGuidance): string {
  return LOCAL_GUIDANCE_OPTIONS.find((row) => row.value === value)?.hint ?? '';
}

/** Auto / On / Off control for the local-model appendix. */
export function mountLocalModelGuidanceControl(
  container: HTMLElement,
  onChange?: (value: LocalModelGuidance) => void,
): void {
  const hint = el('p', 'settings-field-hint');
  const { row, setValue } = createSettingsRadioRow('Local model guidance', {
    name: `localModelGuidance-${Math.random().toString(36).slice(2, 8)}`,
    searchKey: 'agents.localModelGuidance',
    description: 'Extra tool-call discipline for smaller models.',
    options: LOCAL_GUIDANCE_OPTIONS.map(({ value, label }) => ({ value, label })),
    value: 'auto',
    onChange: (raw) => {
      const value = parseLocalModelGuidance(raw);
      hint.textContent = localGuidanceHint(value);
      void savePromptMetaSettings({ localModelGuidance: value })
        .then(() => {
          schedulePromptTokenEstimateRefresh();
          setStatus('idle', `Local model guidance: ${value}`);
          onChange?.(value);
        })
        .catch(() => setStatus('err', 'Could not save local model guidance'));
    },
  });
  container.append(row, hint);
  void loadPromptMetaSettings().then((meta) => {
    setValue(meta.localModelGuidance);
    hint.textContent = localGuidanceHint(meta.localModelGuidance);
  });
}

function openSkillPromptLightbox(skillId: string, title: string, subtitle: string): void {
  openAgentCenterLightbox({
    title,
    subtitle,
    badge: 'Skill',
    render: (body) => {
      appendAgentCenterSection(body, 'SKILL.md', (panel) => {
        const skill = getAllSkillCatalog().find((row) => row.id === skillId);
        if (!skill) {
          panel.appendChild(el('p', 'settings-field-hint', `/${skillId} is not installed.`));
          return;
        }
        mountSkillEditor(panel, skill, () => {
          setStatus('idle', `/${skillId} saved`);
        });
      });
    },
  });
}

async function mountPlanGranularityField(container: HTMLElement): Promise<void> {
  const select = document.createElement('select');
  select.className = 'settings-select';
  const options: { value: string; label: string }[] = [
    { value: 'large', label: 'Large: one task per feature or module' },
    { value: 'medium', label: 'Medium: one task per component or function group (default)' },
    { value: 'small', label: 'Small: separate task for every function and config key' },
  ];
  for (const opt of options) {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    select.appendChild(option);
  }
  const { row } = createSettingsSelectRow('Plan granularity', {
    select,
    description:
      'How finely /plan and Boards break work into tasks. Can be overridden per session.',
  });
  container.appendChild(row);
  const meta = await loadPromptMetaSettings();
  select.value = meta.planGranularity ?? 'medium';
  select.onchange = async () => {
    const value = select.value as 'large' | 'medium' | 'small';
    await savePromptMetaSettings({ planGranularity: value });
    schedulePromptTokenEstimateRefresh();
  };
}

// ── Cards ────────────────────────────────────────────────────────────────────

const SKILL_PROMPTS: { id: string; title: string; description: string; icon: IconName; access: string }[] = [
  { id: 'ask', title: '/ask', description: 'Answers questions without changing anything.', icon: 'modeGeneral', access: 'Read-only turn' },
  { id: 'plan', title: '/plan', description: 'Investigates and writes a plan under documentation/plans/.', icon: 'modePlan', access: 'Plans-only turn' },
  { id: 'debug', title: '/debug', description: 'Reproduces, isolates and fixes a bug with evidence.', icon: 'modeDebug', access: 'Normal permissions' },
];

/** Every card on the Agents page, in display order. */
export function loadAgentCenterCards(): AgentCenterCard[] {
  const cards: AgentCenterCard[] = [
    {
      id: 'prompt:base',
      kind: 'prompts',
      title: 'System prompt',
      description: 'Who the agent is, how it works and communicates, and its safety rules.',
      icon: 'fileText',
      meta: 'Every chat',
      searchKey: 'agents.prompting.base',
      open: () => openPromptFileLightbox({
        title: 'System prompt',
        subtitle: 'Sent first in every chat, sub-agent and board task. {{cwd}}, {{date}}, {{os}} and {{permission_line}} are filled in at send time.',
        badge: 'Prompt',
        family: 'base',
        entityId: 'default',
      }),
    },
    {
      id: 'prompt:tool-usage',
      kind: 'prompts',
      title: 'Tool usage',
      description: 'How to search, read, edit, run commands and load more tools.',
      icon: 'tools',
      meta: 'When tools are on',
      searchKey: 'agents.prompting.toolUsage',
      open: () => openPromptFileLightbox({
        title: 'Tool usage',
        subtitle: 'Follows the system prompt whenever the chat has tools.',
        badge: 'Prompt',
        family: 'tool-usage',
        entityId: 'default',
      }),
    },
    {
      id: 'prompt:local-model',
      kind: 'prompts',
      title: 'Local model guidance',
      description: 'Stricter tool-call and editing rules that help 7–30B models.',
      icon: 'localModel',
      meta: 'Auto · local providers',
      searchKey: 'agents.localModelGuidance',
      open: () => openPromptFileLightbox({
        title: 'Local model guidance',
        subtitle: 'Appended after the other prompts when it applies.',
        badge: 'Prompt',
        family: 'info',
        entityId: 'local-model',
        extra: (body) => appendAgentCenterSection(body, 'When to add it', (panel) => {
          mountLocalModelGuidanceControl(panel);
        }),
      }),
    },
  ];

  for (const skill of SKILL_PROMPTS) {
    cards.push({
      id: `skill:${skill.id}`,
      kind: 'skills',
      title: skill.title,
      description: skill.description,
      icon: skill.icon,
      meta: skill.access,
      searchKey: `agents.skills.${skill.id}`,
      open: () => openSkillPromptLightbox(skill.id, skill.title, `${skill.description} ${skill.access}.`),
    });
  }

  cards.push({
    id: 'mode:orchestrate',
    kind: 'boards',
    title: 'Boards',
    description: 'The coordinator prompt for Orchestrate boards, plus plan granularity.',
    icon: 'boardView',
    meta: 'Orchestrate',
    searchKey: 'agents.boards',
    open: () => openPromptFileLightbox({
      title: 'Boards',
      subtitle: 'Used by the board coordinator chat. Board tasks run as the same agent.',
      badge: 'Prompt',
      family: 'modes',
      entityId: 'orchestrate',
      extra: (body) => appendAgentCenterSection(body, 'Planning', (panel) => {
        void mountPlanGranularityField(panel);
      }),
    }),
  });
  return cards;
}

function renderCardButton(card: AgentCenterCard): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `settings-agent-card settings-agent-card--${card.kind}`;
  btn.dataset.settingsSearchKey = card.searchKey;
  btn.dataset.agentCard = card.id;

  const head = el('div', 'settings-agent-card__head');
  head.appendChild(createIcon(card.icon, { className: 'settings-agent-card__icon' }));
  head.appendChild(el('h3', 'settings-agent-card__title', card.title));
  head.appendChild(createIcon('chevronRight', { className: 'settings-agent-card__chevron' }));
  btn.appendChild(head);
  btn.appendChild(el('p', 'settings-agent-card__desc', card.description));
  if (card.meta) {
    const foot = el('div', 'settings-agent-card__foot');
    foot.appendChild(el('span', 'settings-agent-card__chip', card.meta));
    btn.appendChild(foot);
  }
  btn.addEventListener('click', () => card.open());
  return btn;
}

const AGENT_CENTER_CARD_SECTIONS: {
  id: AgentCenterSectionId;
  title: string;
  hint: string;
  searchKey: string;
}[] = [
  {
    id: 'prompts',
    title: 'Prompts',
    hint: 'What the agent is told in every chat. Edits save as overrides in ~/.minnow/prompts; reset any time.',
    searchKey: 'agents.prompting',
  },
  {
    id: 'skills',
    title: 'Workflow skills',
    hint: 'Slash commands that replace the old modes. /ask and /plan also restrict what the turn may change.',
    searchKey: 'agents.skills',
  },
  {
    id: 'boards',
    title: 'Boards',
    hint: 'Orchestrate boards coordinate several tasks; each task runs as the same agent.',
    searchKey: 'agents.boards',
  },
];

// ── Global ───────────────────────────────────────────────────────────────────

/** Mount global context policy default for all agents. */
async function mountGlobalContextPolicy(mount: HTMLElement): Promise<void> {
  const config = await loadSubAgentConfig();
  const groupBody = appendSettingsGroup(
    mount,
    'Context policy',
    'How a long chat is kept inside the model\'s context window.',
    'agents.contextPolicy',
    { emphasis: true },
  );

  const policySel = createGlobalContextPolicySelect(config.defaultContextEnforcementPolicy);

  groupBody.appendChild(
    createSettingsSelectRow('Global default', { select: policySel }).row,
  );
  const knobs = mountCompactionKnobs(groupBody, config.defaultContextCompaction, (next) =>
    patchSubAgentUserOverrides({ defaultContextCompaction: next }),
  );
  knobs.hidden = policySel.value !== 'compact';

  policySel.addEventListener('change', () => {
    knobs.hidden = policySel.value !== 'compact';
    void (async () => {
      const ok = await patchSubAgentUserOverrides({
        defaultContextEnforcementPolicy: policySel.value as ContextEnforcementPolicy,
      });
      setStatus(
        ok ? 'idle' : 'err',
        ok ? 'Global context policy updated' : 'Could not save. Open or restart Minnow and try again.',
      );
    })();
  });
}

/** Mount global sub-agent limits as an emphasis panel (matches General settings groups). */
async function mountGlobalSubAgentLimits(mount: HTMLElement): Promise<void> {
  const config = await loadSubAgentConfig();
  const groupBody = appendSettingsGroup(
    mount,
    'Sub-agent limits',
    'Sub-agents are the same agent with the same permission level, working on a delegated task.',
    'agents.subAgents.limits',
    { emphasis: true },
  );

  const persistGlobal = async (
    patch: Partial<
      Pick<
        typeof config,
        | 'enabled'
        | 'globalMaxConcurrent'
        | 'checkInNudgeMs'
      >
    >,
  ): Promise<void> => {
    const ok = await patchSubAgentUserOverrides(patch);
    setStatus(ok ? 'idle' : 'err', ok ? 'Sub-agents updated' : 'Could not save. Open or restart Minnow and try again.');
  };

  const { root: enabledSwitch, input: enabledCb } = createSettingsSwitch({
    checked: config.enabled !== false,
    ariaLabel: 'Enable sub-agents',
  });

  const maxInput = document.createElement('input');
  maxInput.type = 'number';
  maxInput.className = 'settings-select settings-kv-input';
  maxInput.min = '1';
  maxInput.max = '16';
  maxInput.step = '1';
  maxInput.value = String(config.globalMaxConcurrent);
  maxInput.setAttribute('aria-label', 'Max concurrent sub-agents');

  const nudgeWrap = el('span', 'settings-kv-input-wrap');
  const nudgeInput = document.createElement('input');
  nudgeInput.type = 'number';
  nudgeInput.className = 'settings-select settings-kv-input';
  nudgeInput.min = '0';
  nudgeInput.step = '1';
  nudgeInput.value = String(msToSeconds(config.checkInNudgeMs ?? 120_000));
  nudgeInput.setAttribute(
    'aria-label',
    'Sub-agent check-in nudge interval in seconds (0 disables)',
  );
  nudgeWrap.appendChild(nudgeInput);
  nudgeWrap.appendChild(el('span', 'settings-kv-suffix', 'sec'));

  groupBody.appendChild(
    createSettingsKvList(
      [
        { term: 'Enabled', value: enabledSwitch },
        { term: 'Max concurrent', value: maxInput },
        { term: 'Check-in nudge', value: nudgeWrap },
      ],
      { className: 'settings-kv settings-kv--row' },
    ),
  );

  const limitsHint = el('p', 'settings-field-hint');
  limitsHint.append(
    'Sub-agents run until they report or are cancelled. They cannot start their own sub-agents. Check-in nudge reminds the parent once while a sub-agent runs (0 turns it off).',
  );
  groupBody.appendChild(limitsHint);

  enabledCb.addEventListener('change', () => {
    void persistGlobal({ enabled: enabledCb.checked });
  });
  maxInput.addEventListener('change', () => {
    const value = Math.min(16, Math.max(1, Math.floor(Number(maxInput.value) || 1)));
    maxInput.value = String(value);
    void persistGlobal({ globalMaxConcurrent: value });
  });
  nudgeInput.addEventListener('change', () => {
    const rawSec = Math.floor(Number(nudgeInput.value) || 0);
    const seconds =
      rawSec <= 0 ? 0 : Math.min(1_800, Math.max(10, rawSec));
    nudgeInput.value = String(seconds);
    void persistGlobal({ checkInNudgeMs: secondsToMs(seconds) });
  });
}

/** Reparent the base prompt disclosure into the agents shell content column. */
export function attachAgentCenterBasePromptPanel(shellContent: HTMLElement | null): void {
  const basePanel = document.getElementById('settingsBasePromptPanel');
  if (!shellContent || !basePanel || basePanel.parentElement === shellContent) return;
  shellContent.appendChild(basePanel);
}

/** Render Settings → Agents into the settings mount. */
export async function renderAgentCenterPanel(
  mount: HTMLElement | null,
): Promise<HTMLElement | null> {
  if (!mount) return null;
  mount.replaceChildren();

  const shell = el('div', 'settings-general settings-agent-center');
  mount.appendChild(shell);

  if (!isServerStorageMode()) {
    appendSettingsOfflineHint(
      shell,
      'Editing prompts requires Minnow running locally. You can still read them.',
    );
  }

  const content = el('div', 'settings-general__content settings-agent-center__content');
  shell.appendChild(content);

  const permissions = appendSettingsGroup(content, 'Permission level', undefined, 'agents.permissions');
  const permissionCards = el('div');
  permissions.appendChild(permissionCards);
  void renderPermissionSettings(permissionCards, { searchKey: 'agents.permissions', showRules: false });
  const safeguards = el('div', 'settings-permissions__safeguards');
  const safeguardsText = el('span');
  safeguardsText.append(
    'The same level covers chats, boards and Scheduler runs. ',
    el('code', '', '~/.minnow/.key'),
    ' and secret stores stay protected at every level.',
  );
  const accessLink = linkToSettingsSection('How access and safeguards work', 'access');
  accessLink.classList.add('settings-permissions__help');
  safeguardsText.append(' ', accessLink);
  safeguards.append(createIcon('lock', { size: 14 }), safeguardsText);
  permissions.appendChild(safeguards);

  void refreshSkillCatalog().catch(() => undefined);
  const cards = loadAgentCenterCards();
  for (const def of AGENT_CENTER_CARD_SECTIONS) {
    const groupBody = appendSettingsGroup(content, def.title, def.hint, def.searchKey, { emphasis: true });
    groupBody.closest('.settings-group')?.classList.add('settings-agent-center__section-group');
    const host = el('div', 'settings-agent-center__section');
    const grid = el('ul', `settings-agent-center__grid settings-agent-center__grid--${def.id}`);
    for (const card of cards.filter((row) => row.kind === def.id)) {
      const item = document.createElement('li');
      item.appendChild(renderCardButton(card));
      grid.appendChild(item);
    }
    host.appendChild(grid);
    groupBody.appendChild(host);
    if (def.id === 'prompts') {
      const guidance = el('div', 'settings-agent-center__inline');
      mountLocalModelGuidanceControl(guidance);
      groupBody.appendChild(guidance);
    }
  }

  await mountGlobalSubAgentLimits(content);
  await mountGlobalContextPolicy(content);
  attachAgentCenterBasePromptPanel(content);

  return content;
}

/** Prompt preview text for a shipped agent part (tests, previews). */
export function shippedAgentPrompt(kind: 'base' | 'tool-usage' | 'info', id: string): string {
  return loadPromptById(kind, id)?.body?.trim() ?? '';
}
