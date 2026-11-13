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
  unmountAuxiliaryModelSelectCombobox,
} from '../model-select-picker';
import { isAppDialogOpen } from '../app-dialog';
import { isolateModalBackground, markOverlayRoot, nextComponentId, trapTabKey, unmarkOverlayRoot } from '../components/internal';
import { createSettingsToggleRow } from '../settings-switch';
import { isWorkspaceFolderPickerOpen, openWorkspaceFolderPicker } from '../workspace-folder-picker';
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
    | 'githubWatch'
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

let activeEditor: { close: () => void; panel: HTMLElement } | null = null;

/** Whether the scheduler job editor overlay is open. */
export function isJobEditorWindowOpen() {
  return Boolean(activeEditor?.panel.isConnected);
}

/** Close the scheduler job editor overlay if open. */
export function closeJobEditorWindow() {
  activeEditor?.close();
}

/** Open the scheduler job editor as a centered overlay on the scheduler app. */
export function openJobEditorWindow(options: JobEditorWindowOptions = {}) {
  if (activeEditor?.panel.isConnected) {
    activeEditor.panel.focus();
    return;
  }
  closeJobEditorWindow();
  const returnFocus = document.activeElement as HTMLElement | null;
  const overlay = el('div', 'scheduler-editor-overlay');
  const backdrop = el('div', 'scheduler-editor-overlay__backdrop');
  backdrop.setAttribute('aria-hidden', 'true');
  const dialog = el('div', 'scheduler-editor-overlay__dialog scheduler-editor-window-body');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.tabIndex = -1;
  const titleId = nextComponentId('scheduler-editor-title');
  dialog.setAttribute('aria-labelledby', titleId);
  overlay.append(backdrop, dialog);
  const host =
    document.getElementById('schedulerView') ??
    document.getElementById('osAppsLayer') ??
    document.body;
  host.appendChild(overlay);
  markOverlayRoot(overlay, 'dialog');
  const restoreBackground = isolateModalBackground(overlay);
  let dismiss = () => close();
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || isWorkspaceFolderPickerOpen() || isAppDialogOpen()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss();
    } else if (event.key === 'Tab') {
      trapTabKey(dialog, event);
    }
  };
  const close = () => {
    if (activeEditor?.panel !== dialog) return;
    const modelSelect = dialog.querySelector<HTMLSelectElement>('.scheduler-model-select');
    if (modelSelect) unmountAuxiliaryModelSelectCombobox(modelSelect);
    activeEditor = null;
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', onRouteChange);
    unmarkOverlayRoot(overlay);
    overlay.remove();
    restoreBackground();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };
  const openedOnSchedulerRoute = window.location.hash.startsWith('#/app/scheduler') || window.location.hash.startsWith('#/scheduler');
  const onRouteChange = () => {
    if (openedOnSchedulerRoute && !window.location.hash.startsWith('#/app/scheduler') && !window.location.hash.startsWith('#/scheduler')) close();
  };
  activeEditor = { panel: dialog, close };
  let pressedOnBackdrop = false;
  overlay.addEventListener('pointerdown', (event) => { pressedOnBackdrop = event.target === backdrop; });
  overlay.addEventListener('click', (event) => {
    if (pressedOnBackdrop && event.target === backdrop) dismiss();
    pressedOnBackdrop = false;
  });
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', onRouteChange);
  void mountEditor(dialog, options, titleId, close, (next) => { dismiss = next; });
  dialog.focus();
}

async function mountEditor(
  mount: HTMLElement,
  options: JobEditorWindowOptions,
  titleId: string,
  close: () => void,
  setDismiss: (dismiss: () => void) => void,
): Promise<void> {
  const panel = el('div', 'scheduler-editor');
  mount.appendChild(panel);

  const editingId = options.jobId ?? null;
  const editorHead = el('div', 'scheduler-editor__head');
  const title = el('h2', 'scheduler-editor__title', editingId ? 'Edit job' : 'New job');
  title.id = titleId;
  editorHead.append(title);
  panel.append(editorHead);

  const formState = { ...EMPTY_FORM, ...options.initialJob };
  const [workspace, providerList] = await Promise.all([
    fetchSchedulerDefaultWorkspace().catch(() => null),
    listProviders().catch(() => null),
  ]);
  if (!mount.isConnected) return;
  const defaultWorkspacePath = workspace?.path || '';
  const defaultWorkspaceLabel = workspace?.label || 'Scheduler';
  const providerLabelById = new Map(providerList?.providers.map((provider) => [provider.id, provider.label || provider.id]));

  const fields = el('div', 'scheduler-editor__fields');

  const kindField = el('label', 'scheduler-field');
  kindField.appendChild(el('span', 'scheduler-field__label', 'Job type'));
  const kindSelect = el('select', 'settings-select');
  for (const [value, label] of [['prompt', 'Agent prompt'], ['github', 'GitHub issue watcher']]) {
    const option = el('option', undefined, label);
    option.value = value;
    kindSelect.appendChild(option);
  }
  kindSelect.value = formState.githubWatch ? 'github' : 'prompt';
  kindSelect.disabled = Boolean(editingId && formState.githubWatch);
  kindField.appendChild(kindSelect);
  fields.appendChild(kindField);

  const repositoryField = el('label', 'scheduler-field');
  repositoryField.appendChild(el('span', 'scheduler-field__label', 'GitHub repository'));
  const repositoryInput = el('input', 'scheduler-input');
  repositoryInput.placeholder = 'owner/repository';
  repositoryInput.value = formState.githubWatch?.repository ?? '';
  repositoryInput.readOnly = Boolean(editingId && formState.githubWatch);
  repositoryField.append(repositoryInput, el('span', 'scheduler-field__hint',
    'Watches open issues labeled minnow. Triages, plans, and runs a board, then pushes a branch and opens a PR after tests pass. Posts progress on the issue using your GitHub CLI login. Choose the matching repository workspace below.'));
  fields.appendChild(repositoryField);

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
  const scheduleLabel = el('label', 'scheduler-field__label', 'Schedule');
  scheduleField.appendChild(scheduleLabel);
  const scheduleMount = mountScheduleField(
    scheduleField,
    formState.schedule,
    (schedule) => {
      formState.schedule = schedule;
    },
  );
  scheduleLabel.htmlFor = scheduleMount.kindId;
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
  const syncJobType = () => {
    const watching = kindSelect.value === 'github';
    repositoryField.hidden = !watching;
    modeField.hidden = watching;
    promptField.querySelector('.scheduler-field__label')!.textContent = watching ? 'Additional guidance (optional)' : 'Prompt';
    promptInput.placeholder = watching ? 'Repository-specific constraints for planning and validation' : 'What should the agent do on each run?';
  };
  kindSelect.addEventListener('change', syncJobType);
  syncJobType();

  const modelField = el('div', 'scheduler-field scheduler-model-field');
  modelField.appendChild(el('span', 'scheduler-field__label', 'Model'));
  const modelSelect = el('select', 'settings-select scheduler-model-select') as HTMLSelectElement;
  modelSelect.id = 'schedulerJobModel';
  modelSelect.setAttribute('aria-label', 'Model');
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
    if (mount.isConnected) syncAuxiliaryModelSelectCombobox(modelSelect);
  })();

  const workspaceField = el('div', 'scheduler-field');
  const workspaceLabel = el('label', 'scheduler-field__label', 'Workspace');
  workspaceField.appendChild(workspaceLabel);
  const workspaceRow = el('div', 'scheduler-workspace-row');

  const workspacePathInput = el('input', 'scheduler-input scheduler-workspace-path') as HTMLInputElement;
  workspacePathInput.id = nextComponentId('scheduler-workspace');
  workspaceLabel.htmlFor = workspacePathInput.id;
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
  browseBtn.disabled = Boolean(editingId && formState.githubWatch);
  browseBtn.addEventListener('click', () => {
    void (async () => {
      const result = await openWorkspaceFolderPicker({
        initialPath: formState.workspacePath || defaultWorkspacePath || undefined,
        title: 'Choose job workspace',
        confirmVerb: 'Choose',
        elevated: true,
      });
      if (result.cancelled || !result.path || !mount.isConnected) return;
      formState.workspacePath = result.path;
      workspacePathInput.value = result.path;
      workspacePathInput.title = result.path;
      workspaceSummary.textContent = workspaceBasename(result.path);
      useDefaultBtn.hidden = false;
    })();
  });

  const useDefaultBtn = el('button', 'settings-inline-btn', 'Use default');
  useDefaultBtn.type = 'button';
  useDefaultBtn.disabled = Boolean(editingId && formState.githubWatch);
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

  const error = el('p', 'scheduler-editor__error');
  error.id = nextComponentId('scheduler-editor-error');
  error.setAttribute('role', 'alert');
  error.tabIndex = -1;
  error.hidden = true;
  panel.append(error, fields);

  const actions = el('div', 'scheduler-editor__actions');
  const saveBtn = el('button', 'settings-action-btn settings-action-btn--primary', 'Save job');
  saveBtn.type = 'button';
  const cancelBtn = el('button', 'settings-action-btn', 'Cancel');
  cancelBtn.type = 'button';
  actions.append(saveBtn, cancelBtn);
  panel.appendChild(actions);

  const discard = el('div', 'scheduler-editor__discard');
  const discardMessage = el('p', undefined, 'Discard unsaved changes?');
  discardMessage.setAttribute('role', 'status');
  const keepBtn = el('button', 'settings-action-btn', 'Keep editing');
  keepBtn.type = 'button';
  const discardBtn = el('button', 'settings-action-btn settings-action-btn--mn-danger', 'Discard changes');
  discardBtn.type = 'button';
  discard.append(discardMessage, keepBtn, discardBtn);
  discard.hidden = true;
  panel.appendChild(discard);

  const draft = () => JSON.stringify([formState, kindSelect.value, repositoryInput.value, scheduleMount.getState()]);
  const initialDraft = draft();
  let saving = false;
  let focusBeforeDiscard: HTMLElement | null = null;
  const keepEditing = () => {
    discard.hidden = true;
    fields.inert = false;
    actions.hidden = false;
    (focusBeforeDiscard ?? cancelBtn).focus();
  };
  const dismiss = () => {
    if (saving) return;
    if (!discard.hidden) { keepEditing(); return; }
    if (draft() === initialDraft) { close(); return; }
    focusBeforeDiscard = document.activeElement as HTMLElement | null;
    fields.inert = true;
    actions.hidden = true;
    discard.hidden = false;
    keepBtn.focus();
  };
  setDismiss(dismiss);
  cancelBtn.addEventListener('click', dismiss);
  keepBtn.addEventListener('click', keepEditing);
  discardBtn.addEventListener('click', close);

  let invalidField: HTMLElement | null = null;
  const clearError = () => {
    invalidField?.removeAttribute('aria-invalid');
    invalidField?.removeAttribute('aria-describedby');
    invalidField = null;
    error.hidden = true;
  };
  const showError = (message: string, field?: HTMLElement) => {
    error.textContent = message;
    error.hidden = false;
    if (field) {
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', error.id);
      invalidField = field;
    }
    (field ?? error).focus();
  };
  const save = async () => {
    if (saving || !discard.hidden) return;
    clearError();
    const label = formState.label.trim();
    if (!label) return showError('Enter a label for this job.', labelInput);
    if (label.length > 120) return showError('Use 120 characters or fewer for the label.', labelInput);
    const scheduleUi = scheduleMount.getState();
    const scheduleCheck = validateScheduleUi(scheduleUi);
    if (scheduleCheck.ok === false) return showError(scheduleCheck.error, scheduleMount.invalidControl());
    const watching = kindSelect.value === 'github';
    const repository = repositoryInput.value.trim();
    if (watching && !/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(repository)) {
      return showError('Enter the GitHub repository as owner/repository.', repositoryInput);
    }
    const workspacePath = formState.workspacePath?.trim() || '';
    if (watching && !workspacePath) return showError('Choose the GitHub repository workspace.', workspacePathInput);
    if (!watching && !formState.prompt.trim()) return showError('Enter a prompt for this job.', promptInput);
    if (formState.prompt.length > 32_000) return showError('Use 32,000 characters or fewer for the prompt.', promptInput);
    const hasPinnedModel = Boolean(formState.providerId?.trim() && formState.modelId?.trim());
    const jobPayload = {
      ...formState,
      schedule: uiToSchedule(scheduleUi),
      githubWatch: watching ? { repository, label: 'minnow' } : null,
      workspacePath,
      providerId: hasPinnedModel ? formState.providerId?.trim() : '',
      modelId: hasPinnedModel ? formState.modelId?.trim() : '',
    };
    saving = true;
    fields.inert = true;
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    mount.setAttribute('aria-busy', 'true');
    mount.focus();
    try {
      if (editingId) await updateSchedulerJob(editingId, jobPayload);
      else await createSchedulerJob(jobPayload);
      if (!mount.isConnected) return;
      close();
      options.onStatus?.('ok', editingId ? 'Job updated' : 'Job created');
      options.onSaved?.();
    } catch (failure) {
      if (mount.isConnected) showError(failure instanceof Error ? failure.message : 'Could not save the job. Try again.');
    } finally {
      saving = false;
      fields.inert = false;
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      saveBtn.textContent = 'Save job';
      mount.removeAttribute('aria-busy');
    }
  };
  saveBtn.addEventListener('click', () => { void save(); });

  if (document.activeElement === mount) labelInput.focus();
}

/** Reset module state (tests). */
export function resetJobEditorWindowForTests(): void {
  closeJobEditorWindow();
}
