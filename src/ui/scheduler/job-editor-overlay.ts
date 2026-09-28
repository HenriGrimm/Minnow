import { listModes } from '../../chat/modes/registry';
import {
  createSchedulerJob,
  fetchSchedulerDefaultWorkspace,
  updateSchedulerJob,
  type ScheduledJob,
} from '../../scheduler/client';
import { uiToSchedule, validateScheduleUi } from '../../scheduler/schedule-display';
import { populateMultiProviderModelSelect } from '../../api/models';
import { formatModelLabel } from '../../lib/format-model-label';
import { decodeModelSelectKey } from '../../lib/model-select-key';
import { listProviders } from '../../providers/store';
import {
  mountAuxiliaryModelSelectCombobox,
  syncAuxiliaryModelSelectCombobox,
} from '../model-select-picker';
import { createSettingsToggleRow } from '../settings-switch';
import { openWorkspaceFolderPicker } from '../workspace-folder-picker';
import { mountScheduleField } from './schedule-field';
import { SCHEDULER_EDITOR_INSTANCE_ID } from '../../os/scheduler-constants';

export { SCHEDULER_EDITOR_INSTANCE_ID };

const EMPTY_FORM: Omit<ScheduledJob, 'id' | 'createdAt' | 'updatedAt' | 'running'> = {
  label: '',
  enabled: true,
  schedule: { kind: 'interval', value: '5m' },
  prompt: '',
  modeId: 'build',
  channels: ['in_app'],
};

export interface JobEditorWindowOptions {
  /** Existing job id when editing; omit for create. */
  jobId?: string;
  /** Seed form fields when editing. */
  initialJob?: Pick<
    ScheduledJob,
    | 'label'
    | 'enabled'
    | 'schedule'
    | 'prompt'
    | 'modeId'
    | 'providerId'
    | 'modelId'
    | 'workspacePath'
    | 'channels'
  >;
  onSaved?: () => void;
  onStatus?: (state: 'ok' | 'err', message: string) => void;
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

/** Folder basename for workspace display. */
function workspaceBasename(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? absPath;
}

/** Human-readable model label for the editor hint. */
function formatJobModelLabel(
  formState: Pick<ScheduledJob, 'providerId' | 'modelId'>,
  providerLabelById: Map<string, string>,
): string {
  const modelId = formState.modelId?.trim();
  if (!modelId) {
    return 'Menubar default';
  }
  const { optionText } = formatModelLabel({ id: modelId });
  const providerId = formState.providerId?.trim();
  const providerLabel = providerId ? providerLabelById.get(providerId) ?? providerId : '';
  return providerLabel ? `${optionText} — ${providerLabel}` : optionText;
}

let overlayRoot: HTMLDivElement | null = null;

/** Whether the scheduler job editor overlay is open. */
export function isJobEditorWindowOpen() {
  return Boolean(overlayRoot?.isConnected);
}

/** Close the scheduler job editor overlay if open. */
export function closeJobEditorWindow() {
  overlayRoot?.remove();
  overlayRoot = null;
}

/** Open the scheduler job editor as a centered overlay on the scheduler app. */
export function openJobEditorWindow(options: JobEditorWindowOptions = {}) {
  closeJobEditorWindow();
  const editingId = options.jobId ?? null;
  overlayRoot = document.createElement('div');
  overlayRoot.className = 'scheduler-editor-overlay';
  const backdrop = document.createElement('button');
  backdrop.type = 'button';
  backdrop.className = 'scheduler-editor-overlay__backdrop';
  backdrop.setAttribute('aria-label', 'Close job editor');
  backdrop.addEventListener('click', () => closeJobEditorWindow());
  const dialog = document.createElement('div');
  dialog.className = 'scheduler-editor-overlay__dialog scheduler-editor-window-body';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  overlayRoot.append(backdrop, dialog);
  const host =
    document.getElementById('schedulerView') ??
    document.getElementById('osAppsLayer') ??
    document.body;
  host.appendChild(overlayRoot);
  void mountEditor(dialog, { ...options, jobId: editingId ?? undefined });
}

async function mountEditor(
  mount: HTMLElement,
  options: JobEditorWindowOptions & { jobId?: string },
): Promise<void> {
  const notify = (state: 'ok' | 'err', message: string) => {
    options.onStatus?.(state, message);
  };

  mount.replaceChildren();

  const panel = el('section', 'scheduler-editor');
  panel.setAttribute('aria-label', 'Job editor');
  mount.appendChild(panel);

  const editingId = options.jobId ?? null;
  const formState = { ...EMPTY_FORM, ...options.initialJob };
  let defaultWorkspacePath = '';
  let defaultWorkspaceLabel = 'Scheduler';
  const providerLabelById = new Map<string, string>();

  try {
    const defaultWorkspace = await fetchSchedulerDefaultWorkspace();
    defaultWorkspacePath = defaultWorkspace.path;
    defaultWorkspaceLabel = defaultWorkspace.label || 'Scheduler';
  } catch {
  }

  try {
    const { providers } = await listProviders();
    for (const provider of providers) {
      providerLabelById.set(provider.id, provider.label || provider.id);
    }
  } catch {
  }

  const editorHead = el('div', 'scheduler-editor__head');
  editorHead.appendChild(
    el('h3', 'scheduler-editor__title', editingId ? 'Edit job' : 'New job'),
  );
  panel.appendChild(editorHead);

  const fields = el('div', 'scheduler-editor__fields');

  const labelField = el('label', 'scheduler-field');
  labelField.appendChild(el('span', 'scheduler-field__label', 'Label'));
  const labelInput = el('input', 'scheduler-input') as HTMLInputElement;
  labelInput.type = 'text';
  labelInput.placeholder = 'Morning standup summary';
  labelInput.value = formState.label;
  labelInput.addEventListener('input', () => {
    formState.label = labelInput.value;
  });
  labelField.appendChild(labelInput);
  fields.appendChild(labelField);

  const scheduleField = el('div', 'scheduler-field');
  scheduleField.appendChild(el('span', 'scheduler-field__label', 'Schedule'));
  const scheduleMount = mountScheduleField(
    scheduleField,
    formState.schedule,
    (schedule) => {
      formState.schedule = schedule;
    },
  );
  fields.appendChild(scheduleField);

  const promptField = el('label', 'scheduler-field');
  promptField.appendChild(el('span', 'scheduler-field__label', 'Prompt'));
  const promptInput = el('textarea', 'scheduler-textarea') as HTMLTextAreaElement;
  promptInput.rows = 5;
  promptInput.placeholder = 'What should the agent do on each run?';
  promptInput.value = formState.prompt;
  promptInput.addEventListener('input', () => {
    formState.prompt = promptInput.value;
  });
  promptField.appendChild(promptInput);
  fields.appendChild(promptField);

  const modeField = el('label', 'scheduler-field');
  modeField.appendChild(el('span', 'scheduler-field__label', 'Mode'));
  const modeSelect = el('select', 'settings-select') as HTMLSelectElement;
  for (const mode of listModes()) {
    const opt = el('option', undefined, mode.label) as HTMLOptionElement;
    opt.value = mode.id;
    if (formState.modeId === mode.id) opt.selected = true;
    modeSelect.appendChild(opt);
  }
  modeSelect.addEventListener('change', () => {
    formState.modeId = modeSelect.value;
  });
  modeField.appendChild(modeSelect);
  fields.appendChild(modeField);

  const modelField = el('div', 'scheduler-field scheduler-model-field');
  modelField.appendChild(el('span', 'scheduler-field__label', 'Model'));
  const modelSelect = el('select', 'settings-select scheduler-model-select') as HTMLSelectElement;
  modelSelect.id = 'schedulerJobModel';
  modelSelect.innerHTML = '<option value="">Loading models…</option>';
  modelField.appendChild(modelSelect);

  const modelHint = el(
    'span',
    'scheduler-field__hint',
    formState.modelId?.trim()
      ? formatJobModelLabel(formState, providerLabelById)
      : 'Uses the model selected in the menubar when this job runs.',
  );
  modelField.appendChild(modelHint);
  fields.appendChild(modelField);

  mountAuxiliaryModelSelectCombobox(modelSelect);
  modelSelect.addEventListener('change', () => {
    const decoded = decodeModelSelectKey(modelSelect.value);
    if (decoded) {
      formState.providerId = decoded.providerId;
      formState.modelId = decoded.modelId;
      modelHint.textContent = formatJobModelLabel(formState, providerLabelById);
    } else {
      formState.providerId = undefined;
      formState.modelId = undefined;
      modelHint.textContent = 'Uses the model selected in the menubar when this job runs.';
    }
  });
  void (async () => {
    await populateMultiProviderModelSelect(modelSelect, {
      selectedProviderId: formState.providerId,
      selectedModelId: formState.modelId,
      includeEmptyOption: true,
      emptyLabel: '(use menubar default)',
    });
    syncAuxiliaryModelSelectCombobox(modelSelect);
  })();

  const workspaceField = el('div', 'scheduler-field');
  workspaceField.appendChild(el('span', 'scheduler-field__label', 'Workspace'));
  const workspaceRow = el('div', 'scheduler-workspace-row');

  const workspacePathInput = el('input', 'scheduler-input scheduler-workspace-path') as HTMLInputElement;
  workspacePathInput.type = 'text';
  workspacePathInput.readOnly = true;
  workspacePathInput.placeholder = defaultWorkspacePath
    ? `${defaultWorkspaceLabel} (default)`
    : 'Scheduler (default)';
  const customWorkspace = formState.workspacePath?.trim();
  workspacePathInput.value = customWorkspace ?? '';
  workspacePathInput.title = customWorkspace || defaultWorkspacePath || workspacePathInput.placeholder;

  const workspaceSummary = el(
    'span',
    'scheduler-workspace-summary',
    customWorkspace
      ? workspaceBasename(customWorkspace)
      : `${defaultWorkspaceLabel} (default)`,
  );

  const browseBtn = el('button', 'settings-inline-btn', 'Browse…');
  browseBtn.type = 'button';
  browseBtn.addEventListener('click', () => {
    void (async () => {
      const result = await openWorkspaceFolderPicker({
        initialPath: customWorkspace || defaultWorkspacePath || undefined,
      });
      if (result.cancelled || !result.path) return;
      formState.workspacePath = result.path;
      workspacePathInput.value = result.path;
      workspacePathInput.title = result.path;
      workspaceSummary.textContent = workspaceBasename(result.path);
      useDefaultBtn.hidden = false;
    })();
  });

  const useDefaultBtn = el('button', 'settings-inline-btn', 'Use default');
  useDefaultBtn.type = 'button';
  useDefaultBtn.hidden = !customWorkspace;
  useDefaultBtn.addEventListener('click', () => {
    formState.workspacePath = undefined;
    workspacePathInput.value = '';
    workspacePathInput.title = defaultWorkspacePath || workspacePathInput.placeholder;
    workspaceSummary.textContent = `${defaultWorkspaceLabel} (default)`;
    useDefaultBtn.hidden = true;
  });

  const workspaceActions = el('div', 'scheduler-workspace-actions');
  workspaceActions.append(browseBtn, useDefaultBtn);
  workspaceRow.append(workspacePathInput, workspaceActions);
  workspaceField.appendChild(workspaceRow);
  workspaceField.appendChild(workspaceSummary);
  workspaceField.appendChild(
    el(
      'span',
      'scheduler-field__hint',
      customWorkspace
        ? 'This job runs in the selected folder.'
        : `Unset jobs run in ${defaultWorkspaceLabel} under ~/.minnow/scheduler-workspace.`,
    ),
  );
  fields.appendChild(workspaceField);

  fields.appendChild(
    createSettingsToggleRow('Enabled', {
      checked: formState.enabled,
      onChange: (on) => {
        formState.enabled = on;
      },
    }).row,
  );

  panel.appendChild(fields);

  const actions = el('div', 'scheduler-editor__actions');
  const saveBtn = el('button', 'settings-action-btn settings-action-btn--primary', 'Save job');
  saveBtn.type = 'button';
  const cancelBtn = el('button', 'settings-action-btn', 'Cancel');
  cancelBtn.type = 'button';
  actions.append(saveBtn, cancelBtn);
  panel.appendChild(actions);

  saveBtn.addEventListener('click', () => {
    void (async () => {
      try {
        const scheduleUi = scheduleMount.getState();
        const scheduleCheck = validateScheduleUi(scheduleUi);
        if (scheduleCheck.ok === false) {
          notify('err', scheduleCheck.error);
          scheduleMount.refreshPreview();
          return;
        }
        formState.schedule = uiToSchedule(scheduleUi);
        const hasPinnedModel =
          Boolean(formState.providerId?.trim()) && Boolean(formState.modelId?.trim());
        const jobPayload = {
          ...formState,
          workspacePath: formState.workspacePath?.trim() || '',
          providerId: hasPinnedModel ? formState.providerId?.trim() : '',
          modelId: hasPinnedModel ? formState.modelId?.trim() : '',
        };
        if (editingId) {
          await updateSchedulerJob(editingId, jobPayload);
          notify('ok', 'Job updated');
        } else {
          await createSchedulerJob(jobPayload);
          notify('ok', 'Job created');
        }
        closeJobEditorWindow();
        options.onSaved?.();
      } catch (err) {
        notify('err', err instanceof Error ? err.message : String(err));
      }
    })();
  });

  cancelBtn.addEventListener('click', () => {
    closeJobEditorWindow();
  });
}

/** Reset module state (tests). */
export function resetJobEditorWindowForTests(): void {
  overlayRoot?.remove();
  overlayRoot = null;
}
