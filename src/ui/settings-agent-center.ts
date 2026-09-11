import '../styles/settings-general.css';
import '../styles/settings-agent-center.css';

import { fetchWorkAgentsList } from '../agents/work-agent-prompt-api';
import type { WorkAgentDefinition } from '../agents/work-agent-types';
import {
  getSubAgentUserOverridesSync,
  loadSubAgentConfig,
  saveSubAgentConfigToServer,
} from '../agents/sub-agent-config';
import type { SubAgentTypeConfig } from '../agents/types';
import type { ContextEnforcementPolicy } from '../chat/context-budget';
import {
  subAgentContextPolicySelectValue,
  workAgentContextPolicySelectValue,
} from '../chat/resolve-context-policy';
import { listModes } from '../chat/modes/registry';
import { createModeMaskIcon } from './mode-icons';
import { createIcon } from './icon';
import { getActiveChat } from '../state/sessions';
import { isServerStorageMode } from '../config/storage-mode';
import { appendSettingsGroup, linkToSettingsSection } from './settings-layout';
import { appendSettingsOfflineHint, createSettingsKvList, createSettingsSelectRow } from './settings-controls';
import { msToSeconds, secondsToMs } from './settings-duration';
import {
  createGlobalContextPolicySelect,
  applyArchiveEmbeddingsGate,
  mountPromptFileEditor,
  mountSubAgentTypeEditor,
  mountWorkAgentConfigEditor,
  mountWorkAgentPromptEditor,
} from './settings-entity-editor';
import { mountStandaloneRoutingEditor } from './settings-model-routing';
import {
  appendAgentCenterSection,
  openAgentCenterLightbox,
} from './settings-agent-center-lightbox';
import {
  loadPromptMetaSettings,
  savePromptMetaSettings,
} from '../config/prompt-meta';
import { schedulePromptTokenEstimateRefresh } from './settings-prompt-estimate';
import { createSettingsSwitch } from './settings-switch';
import { setStatus } from './status';

export type AgentCenterSectionId = 'modes' | 'work-agents' | 'sub-agents';

export interface AgentCenterCard {
  id: string;
  kind: AgentCenterSectionId;
  title: string;
  description: string;
  meta?: string;
  searchKey: string;
  disabled?: boolean;
}

// ── Load ─────────────────────────────────────────────────────────────────────

async function saveSubAgentTypePatch(
  typeId: string,
  patch: Omit<Partial<SubAgentTypeConfig>, 'contextEnforcementPolicy'> & {
    contextEnforcementPolicy?: import('../chat/context-budget').ContextEnforcementPolicy | null;
  },
): Promise<boolean> {
  const userOverrides = getSubAgentUserOverridesSync() ?? {};
  const typeUser = { ...(userOverrides.types?.[typeId] ?? {}) };
  const nextType = { ...typeUser, ...patch } as SubAgentTypeConfig;
  if (patch.contextEnforcementPolicy === null) {
    delete (nextType as { contextEnforcementPolicy?: import('../chat/context-budget').ContextEnforcementPolicy }).contextEnforcementPolicy;
  }
  const types = { ...(userOverrides.types ?? {}), [typeId]: nextType };
  return saveSubAgentConfigToServer({ types });
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

/** Collect cards for the agents center grid. */
export async function loadAgentCenterCards(
  agents: WorkAgentDefinition[] = [],
): Promise<AgentCenterCard[]> {
  const cards: AgentCenterCard[] = [];

  for (const mode of listModes()) {
    const defaultAgent = findDefaultWorkAgentForMode(mode.id, agents);
    cards.push({
      id: `mode:${mode.id}`,
      kind: 'modes',
      title: mode.label,
      description: mode.description,
      meta: defaultAgent
        ? `Default agent: ${defaultAgent.label}`
        : undefined,
      searchKey: `modes.${mode.id}`,
    });
  }

  const remote = await fetchWorkAgentsList();
  for (const agent of remote?.agents ?? []) {
    cards.push({
      id: `work-agent:${agent.id}`,
      kind: 'work-agents',
      title: agent.label,
      description: agent.description,
      meta: agent.defaultForModes?.length
        ? `Default for: ${agent.defaultForModes.join(', ')}`
        : undefined,
      searchKey: `work-agents.${agent.id}`,
      disabled: agent.disabled === true,
    });
  }

  const subConfig = await loadSubAgentConfig();
  for (const [typeId, type] of Object.entries(subConfig.types)) {
    cards.push({
      id: `sub-agent:${typeId}`,
      kind: 'sub-agents',
      title: type.label ?? typeId,
      description:
        type.workAgentId != null
          ? `Uses work agent ${type.workAgentId} for prompt composition.`
          : 'Background worker spawned from parent chats.',
      meta: `Max concurrent ${type.maxConcurrent}`,
      searchKey: `sub-agents.${typeId}`,
      disabled: type.enabled === false,
    });
  }

  return cards;
}

// ── Lightboxes ───────────────────────────────────────────────────────────────

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
      'Controls how finely the Planner breaks work into tasks. The user can override this per session.',
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

function findDefaultWorkAgentForMode(
  modeId: string,
  agents: WorkAgentDefinition[],
): WorkAgentDefinition | null {
  for (const agent of agents) {
    if (agent.disabled || agent.id === 'default') continue;
    if (agent.defaultForModes?.includes(modeId)) return agent;
  }
  return null;
}

/** Open a mode lightbox from settings navigation (e.g. Super Plan pipeline link). */
export async function openModeLightboxFromSettings(modeId: string): Promise<void> {
  const remote = await fetchWorkAgentsList();
  openModeLightbox(modeId, remote?.agents ?? []);
}

function openModeLightbox(modeId: string, agents: WorkAgentDefinition[]): void {
  const mode = listModes().find((m) => m.id === modeId);
  if (!mode) return;
  const defaultAgent = findDefaultWorkAgentForMode(modeId, agents);
  const chat = getActiveChat();

  openAgentCenterLightbox({
    title: mode.label,
    subtitle: mode.description,
    badge: 'Mode',
    render: (body) => {
      appendAgentCenterSection(body, 'Defaults', (panel) => {
        const list = document.createElement('dl');
        list.className = 'agent-center-kv';
        const workDt = document.createElement('dt');
        workDt.textContent = 'Default work agent';
        const workDd = document.createElement('dd');
        workDd.textContent = defaultAgent?.label ?? 'Passthrough (chat picker)';
        const modelDt = document.createElement('dt');
        modelDt.textContent = 'Chat model';
        const modelDd = document.createElement('dd');
        modelDd.textContent = `${chat.modelId || '(none)'} · ${chat.providerId || '(none)'}`;
        const policyDt = document.createElement('dt');
        policyDt.textContent = 'Tool policy';
        const policyDd = document.createElement('dd');
        policyDd.textContent = mode.toolPolicy.default;
        list.append(workDt, workDd, modelDt, modelDd, policyDt, policyDd);
        panel.appendChild(list);
        panel.appendChild(
          el(
            'p',
            'agent-center-section__lead',
            'Modes use the active chat model from the top-bar picker.',
          ),
        );
      });

      if (modeId === 'plan') {
        appendAgentCenterSection(body, 'Mode options', (panel) => {
          void mountPlanGranularityField(panel);
        });
      }

      appendAgentCenterSection(body, 'System prompt', (panel) => {
        mountPromptFileEditor(panel, { family: 'modes', entityId: modeId });
      });
    },
  });
}

function openWorkAgentLightbox(agent: WorkAgentDefinition): void {
  openAgentCenterLightbox({
    title: agent.label,
    subtitle: agent.description,
    badge: 'Work agent',
    render: (body) => {
      appendAgentCenterSection(body, 'Model', (panel) => {
        void mountStandaloneRoutingEditor(panel, agent.id);
      });

      appendAgentCenterSection(body, 'Agent settings', (panel) => {
        mountWorkAgentConfigEditor(panel, {
          agentId: agent.id,
          initialProviderId: agent.providerId,
          initialModelId: agent.modelId,
          initialDisabled: agent.disabled === true,
          initialContextPolicy: workAgentContextPolicySelectValue(agent.id),
          initialArchive: agent.archive,
        });
      });

      appendAgentCenterSection(body, 'System prompt', (panel) => {
        mountWorkAgentPromptEditor(panel, { agentId: agent.id });
      });
    },
  });
}

function openSubAgentLightbox(
  typeId: string,
  type: SubAgentTypeConfig,
  onRefresh: () => void,
): void {
  const label = type.label ?? typeId;
  openAgentCenterLightbox({
    title: label,
    subtitle: type.workAgentId
      ? `Prompt composed via work agent ${type.workAgentId}.`
      : 'Background worker with its own tool policy.',
    badge: 'Sub-agent',
    render: (body) => {
      appendAgentCenterSection(body, 'Model', (panel) => {
        void mountStandaloneRoutingEditor(panel, typeId);
      });

      appendAgentCenterSection(body, 'Type settings', (panel) => {
        mountSubAgentTypeEditor(
          panel,
          typeId,
          label,
          {
            enabled: type.enabled !== false,
            maxConcurrent: type.maxConcurrent,
            contextEnforcementPolicy: subAgentContextPolicySelectValue(typeId),
            summarySchema: type.summarySchema ?? 'minnow.sub-agent.v1',
          },
          async (patch) => {
            const ok = await saveSubAgentTypePatch(typeId, patch);
            if (ok) onRefresh();
            return ok;
          },
        );
      });

      appendAgentCenterSection(body, 'System prompt', (panel) => {
        mountPromptFileEditor(panel, { family: 'sub-agents', entityId: typeId });
      });
    },
  });
}

// ── Cards ────────────────────────────────────────────────────────────────────

function createCardChevron(): HTMLElement {
  return createIcon('chevronRight', { className: 'settings-agent-card__chevron' });
}

function renderCardButton(card: AgentCenterCard, agents: WorkAgentDefinition[]): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `settings-agent-card settings-agent-card--${card.kind}`;
  btn.dataset.settingsSearchKey = card.searchKey;

  const head = el('div', 'settings-agent-card__head');
  if (card.kind === 'modes') {
    const modeId = card.id.replace(/^mode:/, '');
    const icon = createModeMaskIcon(modeId, 'mode-mask-icon settings-agent-card__icon');
    head.appendChild(icon);
  }
  head.appendChild(el('h3', 'settings-agent-card__title', card.title));
  head.appendChild(createCardChevron());
  btn.appendChild(head);

  const desc = el('p', 'settings-agent-card__desc', card.description);
  btn.appendChild(desc);

  const foot = el('div', 'settings-agent-card__foot');
  if (card.meta) {
    foot.appendChild(el('span', 'settings-agent-card__chip', card.meta));
  }
  if (card.disabled) {
    foot.appendChild(el('span', 'settings-badge settings-agent-card__badge', 'disabled'));
  }
  btn.appendChild(foot);

  btn.addEventListener('click', () => {
    if (card.kind === 'modes') {
      openModeLightbox(card.id.replace(/^mode:/, ''), agents);
      return;
    }
    if (card.kind === 'work-agents') {
      const agentId = card.id.replace(/^work-agent:/, '');
      const agent = agents.find((a) => a.id === agentId);
      if (agent) openWorkAgentLightbox(agent);
      return;
    }
    if (card.kind === 'sub-agents') {
      const typeId = card.id.replace(/^sub-agent:/, '');
      void loadSubAgentConfig().then((config) => {
        const type = config.types[typeId];
        if (type) {
          openSubAgentLightbox(typeId, type, () => {
            void renderAgentCenterPanel(document.getElementById('settingsAgentCenterBody'));
          });
        }
      });
    }
  });

  return btn;
}

function createAgentCenterGrid(sectionId: AgentCenterSectionId): HTMLUListElement {
  const grid = el('ul', `settings-agent-center__grid settings-agent-center__grid--${sectionId}`);
  return grid;
}

function cardMatchesQuery(card: AgentCenterCard, query: string): boolean {
  if (!query) return true;
  const hay = `${card.title} ${card.description} ${card.meta ?? ''}`.toLowerCase();
  return hay.includes(query);
}

const AGENT_CENTER_CARD_SECTIONS: {
  id: AgentCenterSectionId;
  title: string;
  hint: string;
  searchKey: string;
}[] = [
  {
    id: 'modes',
    title: 'Modes',
    hint: 'Composer modes — system prompts, tool policy, and mode-specific options.',
    searchKey: 'agents.modes',
  },
  {
    id: 'work-agents',
    title: 'Work agents',
    hint: 'Reusable agent profiles with their own model binding and prompt.',
    searchKey: 'agents.workAgents',
  },
  {
    id: 'sub-agents',
    title: 'Sub-agent types',
    hint: 'Background workers spawned from parent chats.',
    searchKey: 'agents.subAgents',
  },
];

// ── Global ───────────────────────────────────────────────────────────────────

/** Mount global context policy default for all agents. */
async function mountGlobalContextPolicy(mount: HTMLElement): Promise<void> {
  const config = await loadSubAgentConfig();
  const groupBody = appendSettingsGroup(
    mount,
    'Context policy',
    'Default enforcement for work agents and sub-agent types unless they set their own policy.',
    'agents.contextPolicy',
    { emphasis: true },
  );

  const policySel = createGlobalContextPolicySelect(
    config.defaultContextEnforcementPolicy ?? 'summarize',
  );
  void applyArchiveEmbeddingsGate(policySel);

  groupBody.appendChild(
    createSettingsSelectRow('Global default', { select: policySel }).row,
  );

  policySel.addEventListener('change', () => {
    void (async () => {
      const ok = await saveSubAgentConfigToServer({
        defaultContextEnforcementPolicy: policySel.value as ContextEnforcementPolicy,
      });
      setStatus(
        ok ? 'ok' : 'err',
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
    'Concurrency, wall-clock timeout, and parent check-in nudges for every sub-agent type.',
    'agents.subAgents.limits',
    { emphasis: true },
  );

  const persistGlobal = async (
    patch: Partial<
      Pick<
        typeof config,
        | 'enabled'
        | 'globalMaxConcurrent'
        | 'defaultTimeoutMs'
        | 'checkInNudgeMs'
      >
    >,
  ): Promise<void> => {
    const fresh = await loadSubAgentConfig();
    const ok = await saveSubAgentConfigToServer({ ...fresh, ...patch });
    setStatus(ok ? 'ok' : 'err', ok ? 'Sub-agents updated' : 'Could not save. Open or restart Minnow and try again.');
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

  const timeoutWrap = el('span', 'settings-kv-input-wrap');
  const timeoutInput = document.createElement('input');
  timeoutInput.type = 'number';
  timeoutInput.className = 'settings-select settings-kv-input';
  timeoutInput.min = '1';
  timeoutInput.step = '1';
  timeoutInput.value = String(msToSeconds(config.defaultTimeoutMs));
  timeoutInput.setAttribute('aria-label', 'Default sub-agent timeout in seconds');
  timeoutWrap.appendChild(timeoutInput);
  timeoutWrap.appendChild(el('span', 'settings-kv-suffix', 'sec'));

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
        { term: 'Default timeout', value: timeoutWrap },
        { term: 'Check-in nudge', value: nudgeWrap },
      ],
      { className: 'settings-kv settings-kv--row' },
    ),
  );

  const limitsHint = el('p', 'settings-field-hint');
  limitsHint.append(
    'Default timeout is the wall-clock budget for one sub-agent attempt; a caller that passes its own timeout wins. A timeout is a typed exit retried by policy. Check-in nudge reminds the parent agent once while a sub-agent runs (Build, General, and Research only; 0 turns it off).',
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
  timeoutInput.addEventListener('change', () => {
    const seconds = Math.max(1, Math.floor(Number(timeoutInput.value) || 1));
    timeoutInput.value = String(seconds);
    void persistGlobal({ defaultTimeoutMs: secondsToMs(seconds) });
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

/** Render the agents center card grid into the settings mount. */
export async function renderAgentCenterPanel(
  mount: HTMLElement | null,
): Promise<HTMLElement | null> {
  if (!mount) return null;
  mount.replaceChildren();

  const shell = el('div', 'settings-general settings-agent-center');
  mount.appendChild(shell);

  const lead = el('p', 'settings-section-lead');
  lead.append(
    'Composer modes, work agents, and sub-agents. Click a card to edit prompts, model routing, and options. Standing rules live under ',
    linkToSettingsSection('Rules', 'rules'),
    '; per-role models under ',
    linkToSettingsSection('Routing', 'model-routing'),
    '.',
  );
  shell.appendChild(lead);

  if (!isServerStorageMode()) {
    appendSettingsOfflineHint(
      shell,
      'Agent editing requires Minnow running locally. Cards are read-only until then.',
    );
  }

  const toolbar = el('div', 'settings-agent-center__toolbar');
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'settings-select settings-agent-center__search';
  search.placeholder = 'Search modes and agents…';
  search.setAttribute('aria-label', 'Filter agents center');
  const filterCount = el('p', 'settings-agent-center__filter-count');
  filterCount.setAttribute('aria-live', 'polite');
  filterCount.hidden = true;
  toolbar.append(search, filterCount);
  shell.appendChild(toolbar);

  const content = el('div', 'settings-general__content settings-agent-center__content');
  shell.appendChild(content);

  const remote = await fetchWorkAgentsList();
  const agents = remote?.agents ?? [];
  const allCards = await loadAgentCenterCards(agents);

  await mountGlobalContextPolicy(content);
  await mountGlobalSubAgentLimits(content);

  const sectionGrids = new Map<AgentCenterSectionId, HTMLUListElement>();
  const sectionGroups = new Map<AgentCenterSectionId, HTMLElement>();
  const sectionCountEls = new Map<AgentCenterSectionId, HTMLElement>();

  for (const def of AGENT_CENTER_CARD_SECTIONS) {
    const groupBody = appendSettingsGroup(
      content,
      def.title,
      def.hint,
      def.searchKey,
      { emphasis: true },
    );
    const group = groupBody.closest('.settings-group');
    if (!(group instanceof HTMLElement)) continue;

    group.classList.add('settings-agent-center__section-group');

    const heading = group.querySelector('.settings-group__title');
    const count = el('span', 'settings-agent-center__section-count');
    count.setAttribute('aria-hidden', 'true');
    if (heading) {
      heading.appendChild(document.createTextNode(' '));
      heading.appendChild(count);
    }

    const gridHost = el('div', 'settings-agent-center__section');
    groupBody.appendChild(gridHost);

    const grid = createAgentCenterGrid(def.id);
    gridHost.appendChild(grid);
    sectionGrids.set(def.id, grid);
    sectionGroups.set(def.id, group);
    sectionCountEls.set(def.id, count);
  }

  attachAgentCenterBasePromptPanel(content);

  const applyFilter = (): void => {
    const query = search.value.trim().toLowerCase();
    let visibleTotal = 0;

    for (const def of AGENT_CENTER_CARD_SECTIONS) {
      const grid = sectionGrids.get(def.id);
      const group = sectionGroups.get(def.id);
      const countEl = sectionCountEls.get(def.id);
      if (!grid || !group) continue;

      grid.replaceChildren();
      const sectionCards = allCards.filter((card) => card.kind === def.id);
      const filtered = sectionCards.filter((card) => cardMatchesQuery(card, query));

      if (countEl) {
        countEl.textContent = String(filtered.length);
        countEl.hidden = filtered.length === 0;
      }

      if (!filtered.length) {
        group.hidden = true;
        if (def.id === 'sub-agents' && query) {
          group.hidden = false;
          grid.appendChild(
            el('li', 'settings-agent-center__empty', 'No sub-agent types match this search.'),
          );
        }
        continue;
      }

      group.hidden = false;
      visibleTotal += filtered.length;
      for (const card of filtered) {
        const item = document.createElement('li');
        item.appendChild(renderCardButton(card, agents));
        grid.appendChild(item);
      }
    }

    if (query) {
      filterCount.hidden = false;
      filterCount.textContent = `${visibleTotal} match${visibleTotal === 1 ? '' : 'es'}`;
    } else {
      filterCount.hidden = true;
      filterCount.textContent = '';
    }
  };

  search.addEventListener('input', applyFilter);
  applyFilter();

  return content;
}
