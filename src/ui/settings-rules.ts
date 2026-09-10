import {
  computeUserRulesTotalBytes,
  createUserRuleGroup,
  createUserRuleItem,
  loadUserRules,
  MAX_USER_RULES_BYTES,
  normalizeUserRules,
  removeUserRuleGroup,
  saveUserRules,
  getUserRulesSync,
  type UserRuleGroup,
  type UserRuleItem,
  type UserRulesSettings,
} from '../config/user-rules';
import { detectConfigServer } from '../config/storage-mode';
import { appendSettingsGroup } from './settings-layout';
import { appendSettingsOfflineHint } from './settings-controls';
import { createSettingsSwitch, createSettingsToggleRow } from './settings-switch';
import { appAlert, appConfirm } from './app-dialog';
import {
  closeUserRulePopover,
  openUserRuleGroupPopover,
  openUserRulePopover,
  type UserRulePopoverDraft,
} from './settings-rules-popover';
import {
  fetchReplayPriorReasoningEnabled,
  saveReplayPriorReasoningEnabled,
} from '../chat/context/reasoning-replay-config';

type StatusFn = (kind: 'ok' | 'err' | 'spin', message: string) => void;

function rulePreview(title: string, text: string, max = 120): string | null {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;

  const titleNorm = title.trim().replace(/\s+/g, ' ');
  if (titleNorm && trimmed.toLowerCase() === titleNorm.toLowerCase()) {
    return null;
  }

  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

// ── Persist ──────────────────────────────────────────────────────────────────

async function persistRules(
  settings: UserRulesSettings,
  setStatus: StatusFn,
  okMessage = 'User rules saved',
): Promise<boolean> {
  try {
    await saveUserRules(settings);
    const mode = await detectConfigServer();
    setStatus(
      'ok',
      mode === 'server'
        ? okMessage
        : 'Saved locally — open Minnow to persist to disk',
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Save failed';
    setStatus('err', message);
    return false;
  }
}

// ── List ─────────────────────────────────────────────────────────────────────

function renderRulesList(
  mount: HTMLElement,
  settings: UserRulesSettings,
  setStatus: StatusFn,
  onChange: (next: UserRulesSettings) => void,
): void {
  for (const group of settings.groups) {
    const section = document.createElement('section');
    section.className = 'settings-rules-group';
    section.dataset.settingsSearchKey = `agents.rules.group.${group.id}`;

    const head = document.createElement('div');
    head.className = 'settings-rules-group__head';

    const title = document.createElement('h3');
    title.className = 'settings-rules-group__title';
    title.textContent = group.name;
    head.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'settings-rules-group__actions';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'settings-inline-btn';
    addBtn.textContent = 'Add rule';
    addBtn.setAttribute('aria-label', `Add rule to ${group.name}`);
    addBtn.addEventListener('click', () => {
      openUserRulePopover({
        anchor: addBtn,
        mode: 'create',
        groups: settings.groups,
        initial: { title: '', text: '', groupId: group.id },
        existingRules: settings.rules,
        onSubmit: async (draft) => {
          const next = normalizeUserRules({
            ...settings,
            rules: [
              ...settings.rules,
              createUserRuleItem(group.id, {
                title: draft.title,
                text: draft.text,
              }),
            ],
          });
          if (await persistRules(next, setStatus, 'Rule added')) {
            onChange(next);
          }
        },
      });
    });
    actions.appendChild(addBtn);

    if (settings.groups.length > 1) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'settings-inline-btn settings-inline-btn--danger';
      deleteBtn.textContent = 'Delete group';
      deleteBtn.setAttribute('aria-label', `Delete group ${group.name}`);
      deleteBtn.dataset.settingsSearchKey = 'agents.rules.deleteGroup';
      deleteBtn.addEventListener('click', () => {
        void deleteRuleGroup(group, settings, setStatus, onChange);
      });
      actions.appendChild(deleteBtn);
    }

    head.appendChild(actions);
    section.appendChild(head);

    const list = document.createElement('ul');
    list.className = 'settings-rules-list';
    list.setAttribute('role', 'list');

    const groupRules = settings.rules.filter((rule) => rule.groupId === group.id);

    if (!groupRules.length) {
      const empty = document.createElement('p');
      empty.className = 'settings-rules-empty';
      empty.textContent = 'No rules in this group yet.';
      section.appendChild(empty);
    }

    for (const rule of groupRules) {
      list.appendChild(
        renderRuleRow(rule, settings, setStatus, (next) => onChange(next)),
      );
    }

    if (groupRules.length) {
      section.appendChild(list);
    }

    mount.appendChild(section);
  }
}

async function deleteRuleGroup(
  group: UserRuleGroup,
  settings: UserRulesSettings,
  setStatus: StatusFn,
  onChange: (next: UserRulesSettings) => void,
): Promise<void> {
  const preview = removeUserRuleGroup(settings, group.id);
  if (!preview.ok) {
    setStatus('err', preview.error);
    await appAlert(preview.error, 'Cannot delete group');
    return;
  }

  if (
    !(await appConfirm(`Delete the "${group.name}" group?`, {
      confirmLabel: 'Delete',
      danger: true,
      title: 'Delete rule group',
    }))
  ) {
    return;
  }

  const result = removeUserRuleGroup(getUserRulesSync(), group.id);
  if (!result.ok) {
    setStatus('err', result.error);
    await appAlert(result.error, 'Cannot delete group');
    return;
  }

  if (await persistRules(result.settings, setStatus, 'Group deleted')) {
    onChange(result.settings);
  }
}

// ── Row ──────────────────────────────────────────────────────────────────────

function renderRuleRow(
  rule: UserRuleItem,
  settings: UserRulesSettings,
  setStatus: StatusFn,
  onChange: (next: UserRulesSettings) => void,
): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'settings-rules-row';
  if (!rule.enabled) {
    item.classList.add('is-disabled');
  }
  item.dataset.settingsSearchKey = `agents.rules.item.${rule.id}`;

  const { root: switchRoot, input: enabledInput } = createSettingsSwitch({
    checked: rule.enabled,
    ariaLabel: `Enable rule ${rule.title.trim() || 'Untitled rule'}`,
    onChange: (checked) => {
      void (async () => {
        const next = normalizeUserRules({
          ...settings,
          rules: settings.rules.map((row) =>
            row.id === rule.id ? { ...row, enabled: checked } : row,
          ),
        });
        if (await persistRules(next, setStatus)) {
          onChange(next);
        } else {
          enabledInput.checked = rule.enabled;
        }
      })();
    },
  });
  switchRoot.className = 'settings-switch settings-rules-row__switch';
  item.appendChild(switchRoot);

  const body = document.createElement('button');
  body.type = 'button';
  body.className = 'settings-rules-row__body';
  body.setAttribute('aria-label', `Edit rule ${rule.title.trim() || 'Untitled rule'}`);

  const copy = document.createElement('span');
  copy.className = 'settings-rules-row__copy';

  const title = document.createElement('span');
  title.className = 'settings-rules-row__title';
  title.textContent = rule.title.trim() || 'Untitled rule';
  copy.appendChild(title);

  const previewText = rulePreview(rule.title, rule.text);
  if (previewText) {
    const preview = document.createElement('span');
    preview.className = 'settings-rules-row__preview';
    preview.textContent = previewText;
    copy.appendChild(preview);
  }

  body.appendChild(copy);

  const editLabel = document.createElement('span');
  editLabel.className = 'settings-rules-row__edit-label';
  editLabel.textContent = 'Edit';
  body.appendChild(editLabel);

  body.addEventListener('click', () => {
    openUserRulePopover({
      anchor: body,
      mode: 'edit',
      groups: settings.groups,
      initial: {
        title: rule.title,
        text: rule.text,
        groupId: rule.groupId,
      },
      existingRules: settings.rules,
      editingRuleId: rule.id,
      onSubmit: async (draft: UserRulePopoverDraft) => {
        const current = getUserRulesSync();
        const next = normalizeUserRules({
          ...current,
          rules: current.rules.map((row) =>
            row.id === rule.id
              ? {
                  ...row,
                  title: draft.title,
                  text: draft.text,
                  groupId: draft.groupId,
                }
              : row,
          ),
        });
        if (await persistRules(next, setStatus, 'Rule saved')) {
          onChange(next);
        }
      },
      onDelete: async () => {
        const current = getUserRulesSync();
        const next = normalizeUserRules({
          ...current,
          rules: current.rules.filter((row) => row.id !== rule.id),
        });
        if (await persistRules(next, setStatus, 'Rule deleted')) {
          onChange(next);
        }
      },
    });
  });

  item.appendChild(body);

  return item;
}

function renderGroupToolbar(
  mount: HTMLElement,
  settings: UserRulesSettings,
  setStatus: StatusFn,
  onChange: (next: UserRulesSettings) => void,
): void {
  const toolbar = document.createElement('div');
  toolbar.className = 'settings-rules-toolbar';

  const addGroupBtn = document.createElement('button');
  addGroupBtn.type = 'button';
  addGroupBtn.className = 'settings-action-btn';
  addGroupBtn.textContent = 'Add group';
  addGroupBtn.dataset.settingsSearchKey = 'agents.rules.addGroup';
  addGroupBtn.addEventListener('click', () => {
    openUserRuleGroupPopover({
      anchor: addGroupBtn,
      onSubmit: async (name) => {
        const next = normalizeUserRules({
          ...settings,
          groups: [...settings.groups, createUserRuleGroup(name)],
        });
        if (await persistRules(next, setStatus, 'Group added')) {
          onChange(next);
        }
      },
    });
  });

  const bytes = computeUserRulesTotalBytes(settings);
  const usage = document.createElement('span');
  usage.className = 'settings-rules-usage';
  usage.dataset.settingsSearchKey = 'agents.rules.usage';
  usage.textContent = `${bytes.toLocaleString()} / ${MAX_USER_RULES_BYTES.toLocaleString()} bytes used`;

  toolbar.append(addGroupBtn, usage);
  mount.appendChild(toolbar);
}

/** Render user rules controls into a settings content mount. */
/** Prior-turn reasoning replay. */
async function renderReasoningReplaySection(
  mount: HTMLElement,
  setStatus: StatusFn,
): Promise<void> {
  const enabled = await fetchReplayPriorReasoningEnabled();

  const groupBody = appendSettingsGroup(
    mount,
    'Prior reasoning replay',
    'Send a reply’s reasoning back with it on later turns, so the model can see how it reached earlier answers.',
    'agents.rules.reasoningReplay',
    { emphasis: true },
  );

  const { row, input } = createSettingsToggleRow('Replay prior reasoning', {
    id: 'settingsReplayPriorReasoning',
    checked: enabled,
    searchKey: 'agents.rules.reasoningReplay.enabled',
    description:
      'Costs extra tokens on every turn after the first. Tool-call turns already replay their reasoning.',
    onChange: (checked) => {
      void (async () => {
        const ok = await saveReplayPriorReasoningEnabled(checked);
        if (!ok) {
          input.checked = enabled;
          setStatus('err', 'Could not save reasoning replay setting');
          return;
        }
        setStatus('ok', 'Reasoning replay saved');
      })();
    },
  });
  groupBody.appendChild(row);
}

// ── Render ───────────────────────────────────────────────────────────────────

export async function renderRulesSettingsSection(
  mount: HTMLElement,
  setStatus: StatusFn,
): Promise<void> {
  mount.replaceChildren();
  closeUserRulePopover();

  const serverUp = await detectConfigServer();
  if (!serverUp) {
    appendSettingsOfflineHint(
      mount,
      'Open Minnow to persist rules to <code>~/.minnow/rules.json</code>. Edits are kept in this browser until then.',
      { searchKey: 'agents.rules.offline' },
    );
  }

  let settings = normalizeUserRules(await loadUserRules());

  await renderReasoningReplaySection(mount, setStatus);

  const group = appendSettingsGroup(
    mount,
    'User rules',
    'Applied on every parent chat send. Sub-agents do not inherit these instructions.',
    'agents.rules',
    { emphasis: true },
  );

  const { row: enabledRow, input: enabledInput } = createSettingsToggleRow(
    'Enable user rules',
    {
      id: 'settingsRulesEnabled',
      checked: settings.enabled,
      searchKey: 'agents.rules.enabled',
      onChange: (checked) => {
        void (async () => {
          const next = { ...settings, enabled: checked };
          if (await persistRules(next, setStatus)) {
            settings = next;
          } else {
            enabledInput.checked = settings.enabled;
          }
        })();
      },
    },
  );
  group.appendChild(enabledRow);

  const listHost = document.createElement('div');
  listHost.className = 'settings-rules-groups';
  listHost.dataset.settingsSearchKey = 'agents.rules.items';
  group.appendChild(listHost);

  const rerender = (): void => {
    listHost.replaceChildren();
    renderGroupToolbar(listHost, settings, setStatus, (next) => {
      settings = next;
      rerender();
    });
    renderRulesList(listHost, settings, setStatus, (next) => {
      settings = next;
      rerender();
    });
  };

  rerender();
}
