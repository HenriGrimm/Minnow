import '../styles/settings-general.css';
import '../styles/settings-issues.css';

import { appAlert, appConfirm, appPrompt } from './app-dialog';
import { detectConfigServer, isServerStorageMode } from '../config/storage-mode';
import {
  countIssuesUsingTaxonomyId,
  createDefaultIssuesTaxonomy,
  ISSUE_STATUS_ROLES,
  pickNextTaxonomyColor,
  slugifyTaxonomyLabel,
  sortedPriorities,
  sortedStatuses,
  sortedTypes,
  type IssuesTaxonomy,
  type StatusItem,
  type TaxonomyItem,
} from '../issues/taxonomy';
import {
  countIssuesInWorkspace,
  getIssuesSnapshot,
  getNextIssueIdPreview,
  getWorkspaceIdConfig,
  getWorkspaceProjectKey,
  isIssuesStoreLoaded,
  saveIssuesNow,
  setWorkspaceProjectKey,
} from '../state/issues-store';
import {
  getIssuesTaxonomySync,
  saveIssuesTaxonomyNow,
  setIssuesTaxonomy,
} from '../state/issues-taxonomy-store';
import {
  normalizeProjectKeyInput,
  PROJECT_KEY_VALIDATION_MESSAGE,
} from '../issues/project-key';
import { appendSettingsGroup } from './settings-layout';
import {
  ISSUES_GITHUB_MODE_LABELS,
  ISSUES_GITHUB_MODES,
  normalizeGithubMode,
} from '../issues/github-sync-plan';
import {
  getIssuesGithubAuto,
  getIssuesGithubDeleteBehavior,
  getIssuesGithubMode,
  importGithubIssues,
  setIssuesGithubAuto,
  setIssuesGithubDeleteBehavior,
  setIssuesGithubMode,
} from '../state/issues-github';
import { userFacingGithubError } from '../issues/github-error';
import {
  appendSettingsOfflineHint,
  createSettingsInputRow,
  createSettingsKvList,
  createSettingsSelectRow,
} from './settings-controls';
import { createSettingsToggleRow } from './settings-switch';
import { createIcon } from './icon';
import { createIssueTypeIconPickerButton } from './issue-type-icon-picker';
import { createIssueTypeColorPickerButton } from './issue-type-color-picker';
import { getWorkspaceLabel, getWorkspacePath } from '../state/workspace';
import { resolveIssueStatusIcon, resolveIssueTypeColor, resolveIssueTypeIcon } from '../issues/type-icons';
import { setStatus } from './status';

type TaxonomyKind = 'types' | 'statuses' | 'priorities';

const TAXONOMY_ADD_LABEL: Record<TaxonomyKind, string> = {
  types: 'Add type',
  statuses: 'Add status',
  priorities: 'Add priority',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function cloneTaxonomy(): IssuesTaxonomy {
  return structuredClone(getIssuesTaxonomySync());
}

async function persistTaxonomy(
  next: IssuesTaxonomy,
  okMessage = 'Issues taxonomy saved',
): Promise<boolean> {
  try {
    setIssuesTaxonomy(next);
    await saveIssuesTaxonomyNow();
    const mode = await detectConfigServer();
    setStatus(
      'ok',
      mode === 'server'
        ? okMessage
        : 'Saved locally — open Minnow to persist to ~/.minnow',
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Save failed';
    setStatus('err', message);
    return false;
  }
}

// ── Table ────────────────────────────────────────────────────────────────────

function countInUse(kind: 'type' | 'status' | 'priority', id: string): number {
  if (!isIssuesStoreLoaded()) return 0;
  const issues = getIssuesSnapshot()?.issues ?? [];
  return countIssuesUsingTaxonomyId(kind, id, issues);
}

function moveItem<T extends TaxonomyItem>(items: T[], id: string, delta: -1 | 1): T[] {
  const sorted = [...items].sort((a, b) => a.order - b.order);
  const index = sorted.findIndex((item) => item.id === id);
  if (index < 0) return items;
  const swapIndex = index + delta;
  if (swapIndex < 0 || swapIndex >= sorted.length) return items;
  const next = sorted.map((item, i) => {
    if (i === index) return { ...item, order: swapIndex };
    if (i === swapIndex) return { ...item, order: index };
    return { ...item, order: i };
  });
  return next.sort((a, b) => a.order - b.order).map((item, i) => ({ ...item, order: i }));
}

function appendTableColgroup(
  table: HTMLTableElement,
  withStatusColumns: boolean,
  withIconColumn = false,
  withColorColumn = false,
): void {
  const colgroup = document.createElement('colgroup');
  const cols = [];
  if (withIconColumn) cols.push(el('col', 'settings-issues-col-icon'));
  if (withColorColumn) cols.push(el('col', 'settings-issues-col-color'));
  cols.push(
    el('col', 'settings-issues-col-label'),
    el('col', 'settings-issues-col-id'),
  );
  if (withStatusColumns) {
    cols.push(el('col', 'settings-issues-col-role'), el('col', 'settings-issues-col-options'));
  }
  cols.push(el('col', 'settings-issues-col-order'), el('col', 'settings-issues-col-actions'));
  colgroup.append(...cols);
  table.appendChild(colgroup);
}

function renderTaxonomyTable(
  mount: HTMLElement,
  kind: TaxonomyKind,
  title: string,
  hint: string,
  searchKey: string,
  onChange: () => void,
): void {
  const withStatusColumns = kind === 'statuses';
  const withIconColumn = kind === 'types' || kind === 'statuses';
  const withColorColumn = kind === 'types';
  const body = appendSettingsGroup(mount, title, hint, searchKey, { emphasis: true });
  const taxonomy = getIssuesTaxonomySync();
  const items =
    kind === 'types'
      ? sortedTypes(taxonomy)
      : kind === 'statuses'
        ? sortedStatuses(taxonomy)
        : sortedPriorities(taxonomy);

  const wrap = el('div', 'settings-issues-table-wrap');
  const table = document.createElement('table');
  table.className = 'settings-issues-table';

  appendTableColgroup(table, withStatusColumns, withIconColumn, withColorColumn);

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const headers = [
    ...(withIconColumn ? ['Icon'] : []),
    ...(withColorColumn ? ['Color'] : []),
    'Label',
    'Id',
    ...(withStatusColumns ? ['Role', 'Options'] : []),
    'Order',
    '',
  ];
  for (const label of headers) {
    const th = document.createElement('th');
    th.scope = 'col';
    if (label) th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (!items.length) {
    const emptyRow = document.createElement('tr');
    emptyRow.className = 'settings-issues-empty';
    const cell = document.createElement('td');
    cell.colSpan = headers.length;
    cell.textContent = 'No items yet.';
    emptyRow.appendChild(cell);
    tbody.appendChild(emptyRow);
  } else {
    for (const item of items) {
      tbody.appendChild(
        renderTaxonomyRow(kind, item, withStatusColumns, withIconColumn, withColorColumn, onChange),
      );
    }
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  body.appendChild(wrap);

  const toolbar = el('div', 'settings-issues-toolbar');
  const addBtn = el('button', 'settings-inline-btn', TAXONOMY_ADD_LABEL[kind]);
  addBtn.type = 'button';
  addBtn.addEventListener('click', () => {
    void promptAndAddItem(kind, onChange);
  });
  toolbar.appendChild(addBtn);
  body.appendChild(toolbar);
}

function labeledCell(label: string, content: HTMLElement): HTMLTableCellElement {
  const td = document.createElement('td');
  td.dataset.label = label;
  td.appendChild(content);
  return td;
}

function renderTaxonomyRow(
  kind: TaxonomyKind,
  item: TaxonomyItem | StatusItem,
  withStatusColumns: boolean,
  withIconColumn: boolean,
  withColorColumn: boolean,
  onChange: () => void,
): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.className = 'settings-issues-row';
  row.dataset.taxonomyId = item.id;

  if (withIconColumn) {
    const resolved =
      kind === 'statuses'
        ? resolveIssueStatusIcon(item.id, item)
        : resolveIssueTypeIcon(item.id, item);
    const iconBtn = createIssueTypeIconPickerButton(
      resolved,
      item.label,
      (icon) => {
        void updateItemIcon(kind, item.id, icon, onChange);
      },
    );
    row.appendChild(labeledCell('Icon', iconBtn));
  }

  if (withColorColumn) {
    const resolvedColor = resolveIssueTypeColor(item.id, item) ?? 'var(--mn-fg-muted)';
    const colorBtn = createIssueTypeColorPickerButton(resolvedColor, item.label, (color) => {
      void updateItemColor(kind, item.id, color, onChange);
    });
    row.appendChild(labeledCell('Color', colorBtn));
  }

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'settings-input';
  labelInput.value = item.label;
  labelInput.setAttribute('aria-label', `Label for ${item.id}`);
  labelInput.addEventListener('change', () => {
    void updateItemLabel(kind, item.id, labelInput.value.trim(), onChange);
  });

  const idCode = el('code', 'settings-issues-id', item.id);

  row.append(
    labeledCell('Label', labelInput),
    labeledCell('Id', idCode),
  );

  if (withStatusColumns) {
    const status = item as StatusItem;
    const roleSel = document.createElement('select');
    roleSel.className = 'settings-input settings-issues-role';
    roleSel.setAttribute('aria-label', `Role for ${item.id}`);
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '(none)';
    roleSel.appendChild(empty);
    for (const role of ISSUE_STATUS_ROLES) {
      const opt = document.createElement('option');
      opt.value = role;
      opt.textContent = role.replace(/_/g, ' ');
      roleSel.appendChild(opt);
    }
    roleSel.value = status.role ?? '';
    roleSel.addEventListener('change', () => {
      void updateStatusFlags(
        item.id,
        {
          role: roleSel.value ? (roleSel.value as StatusItem['role']) : undefined,
        },
        onChange,
      );
    });

    const flags = el('div', 'settings-issues-flags');
    const boardLabel = document.createElement('label');
    boardLabel.className = 'settings-issues-flag';
    const boardChk = document.createElement('input');
    boardChk.type = 'checkbox';
    boardChk.checked = status.boardVisible !== false;
    boardChk.setAttribute('aria-label', `Board column for ${item.id}`);
    boardLabel.append(boardChk, document.createTextNode('Board'));
    boardChk.addEventListener('change', () => {
      void updateStatusFlags(item.id, { boardVisible: boardChk.checked }, onChange);
    });

    const closedLabel = document.createElement('label');
    closedLabel.className = 'settings-issues-flag';
    const closedChk = document.createElement('input');
    closedChk.type = 'checkbox';
    closedChk.checked = Boolean(status.isClosed);
    closedChk.setAttribute('aria-label', `Closed for ${item.id}`);
    closedLabel.append(closedChk, document.createTextNode('Closed'));
    closedChk.addEventListener('change', () => {
      void updateStatusFlags(item.id, { isClosed: closedChk.checked }, onChange);
    });

    flags.append(boardLabel, closedLabel);
    row.append(labeledCell('Role', roleSel), labeledCell('Options', flags));
  }

  const orderWrap = el('div', 'settings-issues-order');
  const upBtn = el('button', 'settings-action-btn settings-issues-order-btn');
  upBtn.type = 'button';
  upBtn.title = 'Move up';
  upBtn.setAttribute('aria-label', `Move ${item.id} up`);
  upBtn.appendChild(
    createIcon('arrowUp', { className: 'settings-issues-order-btn__icon', size: 16 }),
  );
  upBtn.addEventListener('click', () => {
    void reorderItem(kind, item.id, -1, onChange);
  });
  const downBtn = el('button', 'settings-action-btn settings-issues-order-btn');
  downBtn.type = 'button';
  downBtn.title = 'Move down';
  downBtn.setAttribute('aria-label', `Move ${item.id} down`);
  downBtn.appendChild(
    createIcon('arrowDown', { className: 'settings-issues-order-btn__icon', size: 16 }),
  );
  downBtn.addEventListener('click', () => {
    void reorderItem(kind, item.id, 1, onChange);
  });
  orderWrap.append(upBtn, downBtn);
  row.appendChild(labeledCell('Order', orderWrap));

  const actions = el('div', 'settings-issues-actions');
  const delBtn = el('button', 'settings-inline-btn settings-inline-btn--danger', 'Delete');
  delBtn.type = 'button';
  delBtn.addEventListener('click', () => {
    void deleteItem(kind, item.id, onChange);
  });
  actions.appendChild(delBtn);
  const actionsCell = document.createElement('td');
  actionsCell.className = 'settings-issues-actions';
  actionsCell.dataset.label = 'Actions';
  actionsCell.appendChild(actions);
  row.appendChild(actionsCell);

  return row;
}

// ── Mutations ────────────────────────────────────────────────────────────────

async function updateItemColor(
  kind: TaxonomyKind,
  id: string,
  color: string,
  onChange: () => void,
): Promise<void> {
  if (kind !== 'types') return;
  const next = cloneTaxonomy();
  const item = next.types.find((row) => row.id === id);
  if (!item) return;
  item.color = color;
  if (await persistTaxonomy(next)) onChange();
}

async function updateItemIcon(
  kind: TaxonomyKind,
  id: string,
  icon: string,
  onChange: () => void,
): Promise<void> {
  if (kind !== 'types' && kind !== 'statuses') return;
  const next = cloneTaxonomy();
  const list = kind === 'types' ? next.types : next.statuses;
  const item = list.find((row) => row.id === id);
  if (!item) return;
  item.icon = icon;
  if (await persistTaxonomy(next)) onChange();
}

async function updateItemLabel(
  kind: TaxonomyKind,
  id: string,
  label: string,
  onChange: () => void,
): Promise<void> {
  if (!label) {
    setStatus('err', 'Label cannot be empty');
    onChange();
    return;
  }
  const next = cloneTaxonomy();
  const list = kind === 'types' ? next.types : kind === 'statuses' ? next.statuses : next.priorities;
  const item = list.find((row) => row.id === id);
  if (!item) return;
  item.label = label;
  if (await persistTaxonomy(next)) onChange();
}

async function updateStatusFlags(
  id: string,
  patch: Partial<Pick<StatusItem, 'role' | 'isClosed' | 'boardVisible'>>,
  onChange: () => void,
): Promise<void> {
  const next = cloneTaxonomy();
  const status = next.statuses.find((row) => row.id === id);
  if (!status) return;
  if ('role' in patch) status.role = patch.role;
  if ('isClosed' in patch) status.isClosed = patch.isClosed;
  if ('boardVisible' in patch) status.boardVisible = patch.boardVisible;
  if (await persistTaxonomy(next)) onChange();
}

async function reorderItem(
  kind: TaxonomyKind,
  id: string,
  delta: -1 | 1,
  onChange: () => void,
): Promise<void> {
  const next = cloneTaxonomy();
  if (kind === 'types') next.types = moveItem(next.types, id, delta);
  else if (kind === 'statuses') next.statuses = moveItem(next.statuses, id, delta);
  else next.priorities = moveItem(next.priorities, id, delta);
  if (await persistTaxonomy(next)) onChange();
}

async function deleteItem(
  kind: TaxonomyKind,
  id: string,
  onChange: () => void,
): Promise<void> {
  const useKind = kind === 'types' ? 'type' : kind === 'statuses' ? 'status' : 'priority';
  const inUse = countInUse(useKind, id);
  if (inUse > 0) {
    await appAlert(`Used by ${inUse} issue${inUse === 1 ? '' : 's'} — reassign first.`, 'Cannot delete');
    return;
  }
  const ok = await appConfirm(`Remove "${id}" from ${kind}?`, {
    confirmLabel: 'Delete',
    title: 'Delete taxonomy item',
  });
  if (!ok) return;

  const next = cloneTaxonomy();
  if (kind === 'types') next.types = next.types.filter((row) => row.id !== id);
  else if (kind === 'statuses') next.statuses = next.statuses.filter((row) => row.id !== id);
  else next.priorities = next.priorities.filter((row) => row.id !== id);

  if (next.types.length === 0 || next.statuses.length === 0 || next.priorities.length === 0) {
    setStatus('err', 'Each list must keep at least one item');
    return;
  }

  if (await persistTaxonomy(next, 'Item removed')) onChange();
}

async function promptAndAddItem(kind: TaxonomyKind, onChange: () => void): Promise<void> {
  const label = await appPrompt(`Label for new ${kind.slice(0, -1)}`, '', {
    title: `Add ${kind.slice(0, -1)}`,
    placeholder: 'e.g. Spike',
  });
  if (!label?.trim()) return;

  let id = slugifyTaxonomyLabel(label);
  if (!id) {
    setStatus('err', 'Could not derive an id from that label');
    return;
  }

  const next = cloneTaxonomy();
  const list = kind === 'types' ? next.types : kind === 'statuses' ? next.statuses : next.priorities;
  if (list.some((row) => row.id === id)) {
    const custom = await appPrompt('Id already exists. Enter a unique id', `${id}_2`, {
      title: 'Duplicate id',
    });
    if (!custom?.trim()) return;
    id = custom.trim();
    if (!/^[a-z][a-z0-9_]*$/.test(id)) {
      setStatus('err', 'Id must match [a-z][a-z0-9_]*');
      return;
    }
    if (list.some((row) => row.id === id)) {
      setStatus('err', 'That id is also taken');
      return;
    }
  }

  const order = list.length;
  if (kind === 'statuses') {
    next.statuses.push({
      id,
      label: label.trim(),
      order,
      boardVisible: true,
      icon: resolveIssueStatusIcon(id),
    });
  } else if (kind === 'types') {
    next.types.push({
      id,
      label: label.trim(),
      order,
      icon: resolveIssueTypeIcon(id),
      color: pickNextTaxonomyColor(next.types.map((row) => row.color)),
    });
  } else {
    next.priorities.push({ id, label: label.trim(), order });
  }

  if (await persistTaxonomy(next, 'Item added')) onChange();
}

// ── Panels ───────────────────────────────────────────────────────────────────

function appendIssuesIntro(mount: HTMLElement): void {
  if (!isServerStorageMode()) {
    appendSettingsOfflineHint(
      mount,
      'Issues settings are saved in this browser. Open Minnow to persist under <code>~/.minnow/issues/</code>.',
    );
    return;
  }
  mount.appendChild(
    el(
      'p',
      'settings-section-note',
      'Types, statuses, and priorities for the Issues app. Status roles and board options drive agent workflows and kanban columns.',
    ),
  );
}

function renderIssueIdsPanel(mount: HTMLElement, onChange: () => void): void {
  const workspacePath = getWorkspacePath();
  const storeReady = isIssuesStoreLoaded();
  const savedKey = storeReady ? (getWorkspaceIdConfig(workspacePath)?.projectKey ?? '') : '';
  const body = appendSettingsGroup(
    mount,
    'Issue IDs',
    'New issues in this workspace use your project key (for example MIN-12). Git branches and commit search use the id on each card.',
    'apps.issues.projectKey',
    { emphasis: true },
  );

  const workspaceLabel = getWorkspaceLabel().trim() || workspacePath || '—';
  body.appendChild(
    createSettingsKvList(
      [{ term: 'Workspace', value: el('span', undefined, workspaceLabel) }],
      { searchKey: 'apps.issues.workspace', className: 'settings-kv settings-kv--row' },
    ),
  );

  const errorNode = el('p', 'settings-field-hint settings-field-hint--danger');
  errorNode.hidden = true;

  const previewNode = el('span', 'settings-issues-id-preview');
  previewNode.textContent = storeReady ? getNextIssueIdPreview(workspacePath) : '—';

  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.className = 'settings-input settings-input--mono';
  keyInput.value = savedKey || (storeReady ? getWorkspaceProjectKey(workspacePath) : '');
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  keyInput.setAttribute('aria-describedby', 'settingsIssuesProjectKeyError');

  const { row: keyRow } = createSettingsInputRow('Project key', {
    input: keyInput,
    searchKey: 'apps.issues.projectKey.input',
  });
  body.appendChild(keyRow);

  body.appendChild(
    createSettingsKvList(
      [{ term: 'Next issue', value: previewNode }],
      { searchKey: 'apps.issues.projectKey.preview', className: 'settings-kv settings-kv--row' },
    ),
  );

  errorNode.id = 'settingsIssuesProjectKeyError';
  body.appendChild(errorNode);

  body.appendChild(
    el(
      'p',
      'settings-field-hint',
      'Applies to this workspace only. Existing issue ids are not changed.',
    ),
  );

  const saveBtn = el('button', 'settings-inline-btn', 'Save project key');
  saveBtn.type = 'button';
  saveBtn.disabled = !storeReady;

  const refreshPreviewFromStore = (): void => {
    if (!isIssuesStoreLoaded()) return;
    previewNode.textContent = getNextIssueIdPreview(workspacePath);
    keyInput.value = getWorkspaceIdConfig(workspacePath)?.projectKey ?? getWorkspaceProjectKey(workspacePath);
  };

  keyInput.addEventListener('input', () => {
    const normalized = normalizeProjectKeyInput(keyInput.value);
    keyInput.value = normalized;
    errorNode.hidden = true;
    const draft = normalized;
    if (draft.length >= 2 && isIssuesStoreLoaded()) {
      const basePreview = getNextIssueIdPreview(workspacePath);
      const suffix = basePreview.includes('-') ? basePreview.split('-').slice(1).join('-') : '1';
      previewNode.textContent = `${draft}-${suffix}`;
    } else if (isIssuesStoreLoaded()) {
      previewNode.textContent = getNextIssueIdPreview(workspacePath);
    }
  });

  saveBtn.addEventListener('click', () => {
    void (async () => {
      const draft = normalizeProjectKeyInput(keyInput.value);
      const previous = getWorkspaceIdConfig(workspacePath)?.projectKey;
      if (draft.length < 2 || draft.length > 10) {
        errorNode.textContent = PROJECT_KEY_VALIDATION_MESSAGE;
        errorNode.hidden = false;
        return;
      }
      if (previous && draft !== previous && isIssuesStoreLoaded() && countIssuesInWorkspace(workspacePath) > 0) {
        const ok = await appConfirm(
          `New issues will use ${draft}-n. Existing ids stay the same.`,
          { confirmLabel: 'Save', title: 'Change project key?' },
        );
        if (!ok) return;
      }
      const result = setWorkspaceProjectKey(workspacePath, draft);
      if (!result.ok) {
        errorNode.textContent = result.error;
        errorNode.hidden = false;
        return;
      }
      try {
        await saveIssuesNow();
        const mode = await detectConfigServer();
        setStatus(
          'ok',
          mode === 'server'
            ? 'Issue ID settings saved'
            : 'Saved locally — open Minnow to persist to ~/.minnow',
        );
        refreshPreviewFromStore();
        onChange();
      } catch {
        setStatus('err', 'Could not save issue ID settings');
      }
    })();
  });
  body.appendChild(saveBtn);
}

function renderIssuesTaxonomyPanels(content: HTMLElement, onChange: () => void): void {
  renderTaxonomyTable(
    content,
    'types',
    'Types',
    'Bug, task, idea, note, feature, improvement, or your own kinds. Pick a color so custom types are not grey.',
    'apps.issues.types',
    onChange,
  );
  renderTaxonomyTable(
    content,
    'statuses',
    'Statuses',
    'Assign workflow roles so agents know which column means triage, in progress, review, and done.',
    'apps.issues.statuses',
    onChange,
  );
  renderTaxonomyTable(
    content,
    'priorities',
    'Priorities',
    'Urgency levels for sorting and filters.',
    'apps.issues.priorities',
    onChange,
  );

  const dangerBody = appendSettingsGroup(
    content,
    'Defaults',
    'Restore built-in types, statuses, and priorities. Existing issues keep their current field values.',
    'apps.issues.reset',
    { emphasis: true },
  );
  dangerBody.parentElement?.classList.add('settings-issues-danger-zone');

  const resetBtn = el('button', 'settings-inline-btn', 'Restore defaults');
  resetBtn.type = 'button';
  resetBtn.addEventListener('click', () => {
    void (async () => {
      const ok = await appConfirm(
        'Restore the built-in types, statuses, and priorities? Existing issues keep their current values.',
        { confirmLabel: 'Restore', title: 'Restore defaults' },
      );
      if (!ok) return;
      if (await persistTaxonomy(createDefaultIssuesTaxonomy(), 'Defaults restored')) {
        onChange();
      }
    })();
  });
  dangerBody.appendChild(resetBtn);
}

/** Render Issues taxonomy settings into the mount node. */
export function renderIssuesSettingsSection(mount: HTMLElement): void {
  const refresh = (): void => {
    try {
      mount.replaceChildren();

      const shell = el('div', 'settings-general settings-issues');
      mount.appendChild(shell);

      const content = el('div', 'settings-general__content');
      shell.appendChild(content);

      appendIssuesIntro(content);
      renderIssueIdsPanel(content, refresh);
      renderIssuesGithubPanel(content, refresh);
      renderIssuesTaxonomyPanels(content, refresh);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not render Issues settings';
      if (/issuesState is not initialized/i.test(message)) return;
      setStatus('err', message);
    }
  };

  refresh();
  if (!isIssuesStoreLoaded()) {
    void (async () => {
      try {
        const { loadIssuesTaxonomyFromStorage } = await import('../state/issues-taxonomy-store');
        await loadIssuesTaxonomyFromStorage();
        const { loadIssuesFromStorage } = await import('../state/issues-store');
        await loadIssuesFromStorage();
      } catch {
      }
      if (mount.isConnected) refresh();
    })();
  }
}

/** GitHub sync mode. Off or Two-way mirror; Import is a first-class action. */
function renderIssuesGithubPanel(mount: HTMLElement, onChange: () => void): void {
  const body = appendSettingsGroup(
    mount,
    'GitHub',
    'Sync issues with the GitHub repo for this workspace, through your own `gh` login. No tokens are stored.',
    'apps.issues.github',
  );

  const hint = el('p', 'settings-field-hint');
  const describeMode = (): void => {
    hint.textContent =
      getIssuesGithubMode() === 'off'
        ? 'Nothing is sent to or read from GitHub.'
        : 'Issues sync both ways. When both sides changed, you pick which to keep.';
  };
  describeMode();

  const { row, select } = createSettingsSelectRow('Mode', {
    searchKey: 'apps.issues.github.mode',
    id: 'settingsIssuesGithubMode',
    value: getIssuesGithubMode(),
    options: ISSUES_GITHUB_MODES.map((mode) => ({
      value: mode,
      label: ISSUES_GITHUB_MODE_LABELS[mode],
    })),
  });
  select.addEventListener('change', () => {
    setIssuesGithubMode(normalizeGithubMode(select.value));
    describeMode();
    onChange();
  });

  body.appendChild(row);
  body.appendChild(hint);

  const modeIsOff = getIssuesGithubMode() === 'off';
  const { row: autoRow } = createSettingsToggleRow('Sync automatically', {
    searchKey: 'apps.issues.github.auto',
    id: 'settingsIssuesGithubAuto',
    checked: getIssuesGithubAuto(),
    disabled: modeIsOff,
    description:
      'Pushes title, description, labels, and closed-state as they change, creates a GitHub issue on the first of those edits to an unlinked card, and checks GitHub every 5 minutes (including in the background). When both sides change, the most recent edit wins automatically.',
    onChange: (checked) => {
      setIssuesGithubAuto(checked);
    },
  });
  body.appendChild(autoRow);

  const deleteBehavior = getIssuesGithubDeleteBehavior();
  const rememberedDelete = deleteBehavior === 'github' ? 'Delete everywhere' : 'Local only';
  const { row: deletePromptRow } = createSettingsToggleRow('Ask before deleting linked issues', {
    searchKey: 'apps.issues.github.delete',
    id: 'settingsIssuesGithubDeletePrompt',
    checked: deleteBehavior === 'ask',
    description: deleteBehavior === 'ask'
      ? 'Choose between deleting locally or deleting on GitHub too.'
      : `Off uses the remembered choice: ${rememberedDelete}.`,
    onChange: (checked) => {
      setIssuesGithubDeleteBehavior(checked ? 'ask' : 'local');
      onChange();
    },
  });
  body.appendChild(deletePromptRow);

  const importRow = el('div', 'settings-row settings-issues-github-import');
  importRow.dataset.settingsSearchKey = 'apps.issues.github.import';
  const importLabel = el('div', 'settings-row__label');
  const importTitle = el('span', 'settings-row__title', 'Import');
  const importDesc = el(
    'span',
    'settings-row__desc',
    'Open issues that are not already linked land in Triage.',
  );
  importLabel.append(importTitle, importDesc);
  const importControl = el('div', 'settings-row__control');
  const importActions = el('div', 'settings-actions');

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'settings-action-btn';
  importBtn.textContent = 'Import issues from GitHub';
  const githubImportReady = (): boolean =>
    getIssuesGithubMode() !== 'off' && isIssuesStoreLoaded();
  importBtn.disabled = !githubImportReady();
  importBtn.addEventListener('click', () => {
    importBtn.disabled = true;
    void (async () => {
      try {
        const result = await importGithubIssues();
        if (!result.ok) {
          await appAlert(result.error ?? 'Could not import issues', 'GitHub');
          return;
        }
        await appAlert(
          `Imported ${result.imported}, skipped ${result.skipped} already linked. Imported issues wait in Triage.`,
          'GitHub',
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await appAlert(userFacingGithubError(message, 'Could not import issues'), 'GitHub');
      } finally {
        importBtn.disabled = !githubImportReady();
      }
    })();
  });
  importActions.appendChild(importBtn);
  importControl.appendChild(importActions);
  importRow.append(importLabel, importControl);
  body.appendChild(importRow);
}
