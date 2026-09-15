import { ensureNewIssuePropertyFields } from './issues-new-property-field';
import { ensureNewIssueWorkspaceField } from './issues-new-workspace-field';

const CHROME_MARK = 'data-issues-chrome';

// ── Ensure ───────────────────────────────────────────────────────────────────

/** True when the live DOM already has the Phase 1 shell. */
export function hasIssuesChrome(root: HTMLElement): boolean {
  return Boolean(root.querySelector('.issues-shell'));
}

/** Fill `#issuesView` once. Safe to call on every open. */
export function ensureIssuesChrome(root: HTMLElement): void {
  if (hasIssuesChrome(root)) return;
  root.setAttribute(CHROME_MARK, '1');
  root.replaceChildren();

  const shell = document.createElement('div');
  shell.className = 'issues-shell';

  shell.append(buildHeader(), buildViewTabs(), buildChipBar(), buildBody());
  buildNewForm();
  root.appendChild(shell);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

// ── Header ───────────────────────────────────────────────────────────────────

function buildHeader(): HTMLElement {
  const icon = el('span', { id: 'issuesPageIcon', class: 'issues-header__icon', 'aria-hidden': 'true' });
  const titles = el('div', { class: 'issues-header__titles' }, [
    el('h1', { text: 'Issues' }),
    el('p', { id: 'issuesSummary', class: 'issues-summary', 'aria-live': 'polite' }),
  ]);
  const brand = el('div', { class: 'issues-header__brand' }, [icon, titles]);

  const scope = el('select', { id: 'issuesScope', class: 'issues-filter', 'aria-label': 'Workspace scope' }, [
    el('option', { value: 'current_workspace', text: 'Current workspace' }),
    el('option', { value: 'all', text: 'All workspaces' }),
  ]);
  const scopeLabel = el('label', { class: 'visually-hidden', for: 'issuesScope', text: 'Workspace scope' });

  const toggle = el('div', { class: 'issues-view-toggle', role: 'group', 'aria-label': 'View mode' }, [
    el('button', {
      type: 'button',
      id: 'issuesViewList',
      class: 'is-active',
      'aria-pressed': 'true',
      text: 'List',
    }),
    el('button', { type: 'button', id: 'issuesViewBoard', 'aria-pressed': 'false', text: 'Board' }),
  ]);

  const capture = el('div', { class: 'issues-quick-capture' }, [
    el('label', { class: 'visually-hidden', for: 'issuesQuickCapture', text: 'Quick capture' }),
    el('input', {
      type: 'text',
      id: 'issuesQuickCapture',
      placeholder: 'Quick capture…',
      autocomplete: 'off',
    }),
  ]);

  const newBtn = el('button', {
    type: 'button',
    class: 'issues-btn issues-btn--primary',
    id: 'btnIssuesNew',
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
    text: 'New issue',
  });

  const groupBy = el('button', {
    type: 'button',
    class: 'issues-btn',
    id: 'btnIssuesGroupBy',
    'aria-haspopup': 'menu',
    text: 'Group',
  });

  const filesBtn = el('button', {
    type: 'button',
    class: 'issues-btn',
    id: 'btnIssuesFiles',
    'aria-pressed': 'false',
    title: 'Project files',
    text: 'Files',
  });

  const syncAllBtn = el('button', {
    type: 'button',
    class: 'issues-btn',
    id: 'btnIssuesSyncAll',
    title: 'Sync all issues with GitHub',
    text: 'Sync all',
  });

  const controls = el('div', { class: 'issues-header__controls' }, [
    scopeLabel,
    scope,
    syncAllBtn,
    toggle,
    groupBy,
    filesBtn,
    capture,
    newBtn,
  ]);

  return el('header', { class: 'issues-header' }, [brand, controls]);
}

function buildViewTabs(): HTMLElement {
  const tabs = el('div', {
    class: 'issues-view-tabs',
    id: 'issuesViewTabs',
    role: 'tablist',
    'aria-label': 'Saved views',
  });
  const searchWrap = el('div', { class: 'issues-view-tabs__search' }, [
    el('label', { class: 'visually-hidden', for: 'issuesSearch', text: 'Search issues' }),
    el('input', {
      type: 'search',
      id: 'issuesSearch',
      class: 'issues-search',
      placeholder: 'Search issues…',
      autocomplete: 'off',
    }),
  ]);
  return el('div', { class: 'issues-view-bar' }, [tabs, searchWrap]);
}

function buildChipBar(): HTMLElement {
  return el('div', {
    class: 'issues-chip-bar',
    id: 'issuesChipBar',
    'aria-label': 'Active filters',
  });
}

// ── Form ─────────────────────────────────────────────────────────────────────

function buildNewForm(): HTMLElement {
  const existing = document.getElementById('issuesNewForm');
  if (existing) {
    ensureNewIssueWorkspaceField(existing);
    ensureNewIssuePropertyFields(existing);
    if (!document.getElementById('issuesNewFormBackdrop')) {
      const backdrop = el('button', {
        type: 'button',
        id: 'issuesNewFormBackdrop',
        class: 'issues-new-form__backdrop',
        'aria-label': 'Dismiss new issue',
      });
      document.body.insertBefore(backdrop, existing);
    }
    return existing;
  }

  const title = el('label', { class: 'issues-new-form__title' }, [
    el('span', { class: 'issues-new-form__field-label', text: 'Title' }),
    el('input', {
      type: 'text',
      id: 'issuesNewTitle',
      required: '',
      autocomplete: 'off',
      placeholder: 'What needs doing?',
    }),
  ]);
  const workspace = el('label', {
    id: 'issuesNewWorkspaceWrap',
    class: 'issues-new-form__workspace',
    hidden: '',
  }, [
    document.createTextNode('Workspace'),
    el('select', { id: 'issuesNewWorkspace', 'aria-label': 'Workspace' }),
  ]);
  const type = el('label', { class: 'issues-new-form__prop' }, [
    el('span', { class: 'issues-new-form__field-label', text: 'Type' }),
    el('input', { type: 'hidden', id: 'issuesNewType', value: 'task' }),
    el('div', { id: 'issuesNewTypeHost', class: 'issues-new-form__prop-host' }),
  ]);
  const priority = el('label', { class: 'issues-new-form__prop' }, [
    el('span', { class: 'issues-new-form__field-label', text: 'Priority' }),
    el('input', { type: 'hidden', id: 'issuesNewPriority', value: 'none' }),
    el('div', { id: 'issuesNewPriorityHost', class: 'issues-new-form__prop-host' }),
  ]);
  const labels = el('div', { class: 'issues-new-form__labels' }, [
    el('span', { class: 'issues-new-form__field-label', text: 'Labels' }),
    el('div', { id: 'issuesNewLabelsHost', class: 'issues-new-form__labels-host' }),
  ]);
  const desc = el('div', { class: 'issues-new-form__desc' }, [
    el('span', { class: 'issues-new-form__field-label', text: 'Description' }),
    el('div', {
      id: 'issuesNewDescriptionHost',
      class: 'issues-detail__desc-wrap is-editing',
    }),
  ]);
  const grid = el('div', { class: 'issues-new-form__grid' }, [title, workspace, type, priority, labels, desc]);
  const actions = el('div', { class: 'issues-new-form__actions' }, [
    el('button', { type: 'submit', class: 'issues-btn issues-btn--primary', text: 'Create issue' }),
    el('button', { type: 'button', class: 'issues-btn', id: 'btnIssuesNewCancel', text: 'Cancel' }),
  ]);
  const backdrop = el('button', {
    type: 'button',
    id: 'issuesNewFormBackdrop',
    class: 'issues-new-form__backdrop',
    'aria-label': 'Dismiss new issue',
  });
  const form = el('form', { id: 'issuesNewForm', class: 'issues-new-form', 'aria-label': 'New issue' }, [
    grid,
    actions,
  ]);
  document.body.append(backdrop, form);
  return form;
}

// ── Body ─────────────────────────────────────────────────────────────────────

function sortHead(key: string, label: string, extraClass: string, ariaSort = 'none'): HTMLButtonElement {
  const btn = el('button', {
    type: 'button',
    class: `issues-list-head__sort ${extraClass}`,
    'data-sort-key': key,
    'aria-sort': ariaSort,
  });
  btn.append(
    el('span', { class: 'issues-list-head__sort-label', text: label }),
    el('span', { class: 'issues-list-head__sort-indicator', 'aria-hidden': 'true' }),
  );
  return btn;
}

function buildBody(): HTMLElement {
  const selectionActions = el('div', { class: 'issues-selection-bar__actions' }, [
    el('button', { type: 'button', class: 'issues-btn', id: 'btnIssuesBulkStatus', text: 'Status' }),
    el('button', { type: 'button', class: 'issues-btn', id: 'btnIssuesBulkPriority', text: 'Priority' }),
    el('button', { type: 'button', class: 'issues-btn', id: 'btnIssuesBulkAssignee', text: 'Assignee' }),
    el('button', { type: 'button', class: 'issues-btn', id: 'btnIssuesBulkLabels', text: 'Labels' }),
    el('button', { type: 'button', class: 'issues-btn', id: 'btnIssuesBulkProject', text: 'Project' }),
    el('button', {
      type: 'button',
      class: 'issues-btn issues-btn--danger',
      id: 'btnIssuesDeleteSelected',
      text: 'Delete',
    }),
    el('button', { type: 'button', class: 'issues-btn', id: 'btnIssuesClearSelection', text: 'Clear' }),
  ]);
  const selectionBar = el('div', { id: 'issuesSelectionBar', class: 'issues-selection-bar', hidden: '' }, [
    el('span', { id: 'issuesSelectionCount', class: 'issues-selection-bar__count' }),
    selectionActions,
  ]);

  // Identity cluster first so priority sits next to the id while scanning.
  const head = el('div', { id: 'issuesListHead', class: 'issues-list-head', hidden: '', role: 'row' }, [
    sortHead('id', 'ID', 'issues-list-head__id'),
    sortHead('priority', 'Priority', 'issues-list-head__priority'),
    sortHead('type', 'Type', 'issues-list-head__type'),
    sortHead('title', 'Title', 'issues-list-head__title'),
    sortHead('labels', 'Labels', 'issues-list-head__labels'),
    el('span', { class: 'issues-list-head__assignee', text: 'Assignee' }),
    el('span', { class: 'issues-list-head__project', text: 'Project' }),
    el('span', { class: 'issues-list-head__agent', text: 'Agent' }),
    el('span', { class: 'issues-list-head__rollup', text: 'Sub' }),
    el('span', { class: 'issues-list-head__counts', text: 'Links' }),
    sortHead('status', 'Status', 'issues-list-head__status'),
    sortHead('created', 'Created', 'issues-list-head__created', 'descending'),
  ]);

  const pane = el('div', { class: 'issues-list-pane' }, [
    head,
    el('div', { id: 'issuesPanelMount', class: 'issues-main', role: 'region', 'aria-label': 'Issues' }),
  ]);

  return el('div', { class: 'issues-body' }, [selectionBar, pane]);
}
