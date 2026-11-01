import { createCheckbox, createSelect, setControlClassName } from './components';
import { createButton, setButtonClassName } from './components';
import {
  isToolPermissionMode,
  saveToolCacheFromUi,
  saveWebSearchSettingsFromDrawer,
  setToolPermission,
  setToolsEnabled,
  getToolIdsForCategory,
} from '../tools/config';
import { isAppEnabled } from '../os/app-preferences';
import {
  BUILT_IN_TOOLS,
  type ToolCategory,
} from '../tools/definitions';

/** Category order and labels for tool permission lists. */
const TOOL_CATEGORY_ORDER: ToolCategory[] = [
  'web',
  'utility',
  'browser',
  'agents',
  'lsp',
  'files',
  'git',
  'code',
];

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

export type ToolsListVariant = 'default' | 'composer' | 'settings';

export type FillToolsSectionOptions = {
  variant?: ToolsListVariant;
};

let toolHandlersRegistered = false;

// ── Collapsible groups ───────────────────────────────────────────────────────

/** Keep category bulk toggles from opening or closing the group summary. */
function stopSummaryToggle(event: Event): void {
  event.stopPropagation();
}

/** Build a collapsed-by-default category panel for Settings → Tools. */
function wrapCollapsibleToolGroup(
  category: ToolCategory,
  toolCount: number,
  head: HTMLElement,
  bodyNodes: HTMLElement[],
): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'tool-group tool-group--collapsible';
  details.setAttribute('data-tool-category', category);
  details.dataset.settingsSearchKey = `tools.category.${category}`;

  const summary = document.createElement('summary');
  summary.className = 'tool-group-summary';

  const main = document.createElement('span');
  main.className = 'tool-group-summary__main';

  const chevron = document.createElement('span');
  chevron.className = 'tool-group-summary__chevron';
  chevron.setAttribute('aria-hidden', 'true');

  const title = document.createElement('span');
  title.className = 'tool-group-header';
  title.textContent =
    head.querySelector('.tool-group-header')?.textContent ??
    TOOL_CATEGORY_LABELS[category];

  main.append(chevron, title);

  const count = document.createElement('span');
  count.className = 'tool-group-count';
  count.textContent = `${toolCount} tool${toolCount === 1 ? '' : 's'}`;

  summary.append(main, count);

  const selectAll = head.querySelector('.tool-select-all');
  if (selectAll instanceof HTMLLabelElement) {
    selectAll.classList.add('tool-select-all--category');
    const labelText = selectAll.querySelector('span');
    if (labelText) labelText.textContent = 'Enable all';
    selectAll.addEventListener('click', stopSummaryToggle);
    summary.appendChild(selectAll);
  }

  const body = document.createElement('div');
  body.className = 'tool-group-body';
  for (const node of bodyNodes) body.appendChild(node);

  details.append(summary, body);
  return details;
}

/** Group shell for dynamic tool sources (plugins, MCP servers) so their rows keep the same shape as built-in categories: collapsible in Settings, plain section in the drawer. */
export function createDynamicToolGroup(options: {
  category: string;
  title: string;
  count: string;
  searchKey: string;
  collapsible: boolean;
  bodyNodes: HTMLElement[];
}): HTMLElement {
  if (!options.collapsible) {
    const group = document.createElement('section');
    group.className = 'tool-group';
    group.setAttribute('data-tool-category', options.category);
    group.dataset.settingsSearchKey = options.searchKey;

    const head = document.createElement('div');
    head.className = 'tool-group-head';
    const header = document.createElement('h3');
    header.className = 'tool-group-header';
    header.textContent = options.title;
    head.appendChild(header);
    group.appendChild(head);

    for (const node of options.bodyNodes) group.appendChild(node);
    return group;
  }

  const details = document.createElement('details');
  details.className = 'tool-group tool-group--collapsible';
  details.setAttribute('data-tool-category', options.category);
  details.dataset.settingsSearchKey = options.searchKey;

  const summary = document.createElement('summary');
  summary.className = 'tool-group-summary';

  const main = document.createElement('span');
  main.className = 'tool-group-summary__main';

  const chevron = document.createElement('span');
  chevron.className = 'tool-group-summary__chevron';
  chevron.setAttribute('aria-hidden', 'true');

  const title = document.createElement('span');
  title.className = 'tool-group-header';
  title.textContent = options.title;

  main.append(chevron, title);

  const count = document.createElement('span');
  count.className = 'tool-group-count';
  count.textContent = options.count;

  summary.append(main, count);

  const body = document.createElement('div');
  body.className = 'tool-group-body';
  for (const node of options.bodyNodes) body.appendChild(node);

  details.append(summary, body);
  return details;
}

// ── Tool controls ────────────────────────────────────────────────────────────

/** Build a per-category or global "select all" control. */
function createToolSelectAllControl(
  scope: 'global' | ToolCategory,
  labelText: string,
): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'tool-select-all';

  const checkbox = createCheckbox({ appearance: 'surface', label: '' }).input;
  checkbox.type = 'checkbox';
  if (scope === 'global') {
    checkbox.setAttribute('data-select-all', 'global');
    checkbox.setAttribute('aria-label', 'Enable all tools');
  } else {
    checkbox.setAttribute('data-select-all-category', scope);
    checkbox.setAttribute(
      'aria-label',
      `Enable all ${TOOL_CATEGORY_LABELS[scope]} tools`,
    );
  }

  const text = document.createElement('span');
  text.textContent = labelText;
  label.append(checkbox, text);
  return label;
}

/** Compact Off / Ask / Full control for the composer tools popover. */
function createToolPermissionSegments(
  toolLabel: string,
): HTMLDivElement {
  const group = document.createElement('div');
  group.className = 'tool-permission-segments';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', `${toolLabel} permission`);

  for (const optDef of [
    { value: 'off', label: 'Off' },
    { value: 'ask', label: 'Ask' },
    { value: 'full', label: 'Full' },
  ] as const) {
    const button = createButton({ appearance: 'surface', variant: 'ghost', size: 'sm' });
    button.type = 'button';
    setButtonClassName(button, 'tool-permission-segment');
    button.dataset.value = optDef.value;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');
    button.textContent = optDef.label;
    group.appendChild(button);
  }

  return group;
}

/** Handle permission select and bulk checkbox changes on a tools list. */
function handleToolsListChange(event: Event, list: HTMLElement): void {
  const target = event.target;
  if (
    target instanceof HTMLButtonElement &&
    target.classList.contains('tool-permission-segment')
  ) {
    const row = target.closest<HTMLElement>('[data-tool-id]');
    const id = row?.getAttribute('data-tool-id');
    if (!id) return;
    const mode = target.dataset.value;
    if (!isToolPermissionMode(mode)) return;
    setToolPermission(id, mode, list);
    void import('./context-usage-ring').then((m) => m.scheduleContextUsageRefresh());
    return;
  }

  if (
    target instanceof HTMLSelectElement &&
    target.classList.contains('tool-permission-select')
  ) {
    const row = target.closest<HTMLElement>('[data-tool-id]');
    const id = row?.getAttribute('data-tool-id');
    if (!id) return;
    const mode = target.value;
    if (!isToolPermissionMode(mode)) return;
    setToolPermission(id, mode, list);
    void import('./context-usage-ring').then((m) => m.scheduleContextUsageRefresh());
    return;
  }

  if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') {
    return;
  }

  if (target.getAttribute('data-select-all') === 'global') {
    const ids = BUILT_IN_TOOLS.map((tool) => tool.id);
    setToolsEnabled(ids, target.checked, list);
    return;
  }

  const category = target.getAttribute('data-select-all-category');
  if (category) {
    const ids = getToolIdsForCategory(category as ToolCategory);
    setToolsEnabled(ids, target.checked, list);
    return;
  }
}

/** Wire change delegation once per tools list element. */
export function bindToolsListChange(list: HTMLElement): void {
  if (list.dataset.toolsChangeBound === 'true') return;
  list.dataset.toolsChangeBound = 'true';
  list.addEventListener('change', (event) => handleToolsListChange(event, list));
  list.addEventListener('click', (event) => handleToolsListChange(event, list));
}

// ── Fill section ─────────────────────────────────────────────────────────────

/** Populate a tool list container with grouped permission rows. */
export function fillToolsSection(
  containerId = 'toolsList',
  options: FillToolsSectionOptions = {},
): void {
  const container = document.getElementById(containerId);
  if (!container) return;

  const variant = options.variant ?? 'default';
  container.replaceChildren();
  container.classList.toggle('tools-list--composer', variant === 'composer');
  container.classList.toggle('tools-list--settings', variant === 'settings');
  container.dataset.toolsFilled = '1';
  container.dataset.toolsVariant = variant;

  const toolbar = document.createElement('div');
  toolbar.className = 'tool-list-toolbar';
  toolbar.appendChild(
    createToolSelectAllControl(
      'global',
      variant === 'composer' ? 'Enable all' : 'Enable all tools',
    ),
  );
  container.appendChild(toolbar);

  for (const category of TOOL_CATEGORY_ORDER) {
    const tools = BUILT_IN_TOOLS.filter(
      (tool) => tool.category === category && (!tool.appId || isAppEnabled(tool.appId)),
    );
    if (tools.length === 0) continue;

    const head = document.createElement('div');
    head.className = 'tool-group-head';

    const header = document.createElement('h3');
    header.className = 'tool-group-header';
    header.textContent = TOOL_CATEGORY_LABELS[category];

    head.append(header);
    if (variant !== 'composer') {
      head.append(createToolSelectAllControl(category, 'All'));
    }

    const bodyNodes: HTMLElement[] = [];

    if (category === 'browser' && variant !== 'composer') {
      const hint = document.createElement('p');
      hint.className = 'tool-group-hint';
      hint.textContent =
        'Requires the Minnow desktop app for allowlist configuration.';
      bodyNodes.push(hint);
    }

    for (const tool of tools) {
      const row = document.createElement('div');
      row.className = 'tool-row';
      row.setAttribute('data-tool-id', tool.id);
      row.dataset.settingsSearchKey = `tools.item.${tool.id}`;
      if (tool.serverRequired) {
        row.setAttribute('data-server-required', '');
      }
      if (tool.previewRequired) {
        row.setAttribute('data-preview-required', '');
      }

      const controlWrap = document.createElement('div');
      controlWrap.className = 'tool-permission-wrap';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'tool-label';
      nameSpan.textContent = tool.label;

      const select = createSelect({ appearance: 'surface',});
      setControlClassName(select, 'tool-permission-select');
      select.setAttribute('aria-label', `${tool.label} permission`);
      if (variant !== 'composer') {
        select.setAttribute('aria-describedby', `tool-desc-${tool.id}`);
        for (const optDef of [
          { value: 'off', label: 'Disabled' },
          { value: 'ask', label: 'Requires permission' },
          { value: 'full', label: 'Full permission' },
        ] as const) {
          const opt = document.createElement('option');
          opt.value = optDef.value;
          opt.textContent = optDef.label;
          select.appendChild(opt);
        }
        controlWrap.append(nameSpan, select);
      } else {
        controlWrap.append(nameSpan, createToolPermissionSegments(tool.label));
      }

      row.appendChild(controlWrap);

      if (variant !== 'composer') {
        const desc = document.createElement('p');
        desc.className = 'tool-desc';
        desc.id = `tool-desc-${tool.id}`;
        desc.textContent = tool.description;
        row.appendChild(desc);
      }

      bodyNodes.push(row);
    }

    if (variant === 'settings' || variant === 'composer') {
      container.appendChild(
        wrapCollapsibleToolGroup(category, tools.length, head, bodyNodes),
      );
      continue;
    }

    const group = document.createElement('section');
    group.className = 'tool-group';
    group.setAttribute('data-tool-category', category);
    group.dataset.settingsSearchKey = `tools.category.${category}`;
    group.appendChild(head);
    for (const node of bodyNodes) group.appendChild(node);
    container.appendChild(group);
  }

  bindToolsListChange(container);
}

/** Build a tools list on first use (boot defers these so cold start does not construct 100+ permission rows four times before first paint). */
export function ensureToolsSectionFilled(
  containerId: string,
  options: FillToolsSectionOptions = {},
): void {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (container.dataset.toolsFilled === '1' && container.querySelector('[data-tool-id]')) {
    return;
  }
  fillToolsSection(containerId, options);
}

// ── Register ─────────────────────────────────────────────────────────────────

/** Bind tool lists and Brave API key field to config handlers (once per app boot). */
export function registerToolHandlers(): void {
  if (toolHandlersRegistered) return;
  toolHandlersRegistered = true;

  const drawerList = document.getElementById('toolsList');
  if (drawerList) {
    bindToolsListChange(drawerList);
  }

  const settingsList = document.getElementById('settingsToolsList');
  if (settingsList) {
    bindToolsListChange(settingsList);
  }

  const composerList = document.getElementById('composerToolsList');
  if (composerList) {
    bindToolsListChange(composerList);
  }

  const webSearchFields = [
    'braveApiKey',
    'tavilyApiKey',
    'webSearchProvider',
    'composerToolsWebSearchProvider',
    'chatAppToolsWebSearchProvider',
    'desktopToolsWebSearchProvider',
  ];
  for (const id of webSearchFields) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('input', (event) => saveWebSearchSettingsFromDrawer(event));
    el.addEventListener('change', (event) => saveWebSearchSettingsFromDrawer(event));
  }

  for (const id of [
    'settingsToolCacheEnabled',
    'composerToolsCacheEnabled',
    'chatAppToolsCacheEnabled',
    'desktopToolsCacheEnabled',
  ]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('change', saveToolCacheFromUi);
  }
}
