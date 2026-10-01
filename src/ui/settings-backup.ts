/**
 * Settings → General → Backup and restore (MIN-16).
 *
 * One group, four parts: what a backup includes, a manual backup, scheduled
 * snapshots, and restore. The server owns every rule (what is secret, where a
 * backup may go); this file only collects choices and reports outcomes.
 */

import {
  BackupApiError,
  backupFileName,
  backupProgressPercent,
  cancelPendingRestore,
  discardPreviousData,
  fetchBackupSizes,
  fetchBackupStatus,
  formatBackupBytes,
  formatBackupWhen,
  retryPendingRestore,
  saveBackupSettings,
  startBackupExport,
  startSnapshotNow,
  undoLastRestore,
  waitForBackupJob,
  type BackupCategorySize,
  type BackupJob,
  type BackupSettings,
  type BackupStatus,
  type SnapshotFrequency,
} from '../backup/client';
import { detectConfigServer } from '../config/storage-mode';
import { appConfirm } from './app-dialog';
import { backupNote, createBackupProgress, mountRestorePanel, type RestorePanelHandle } from './backup-restore-panel';
import {
  appendSettingsOfflineHint,
  createSettingsActionsRow,
  createSettingsInputRow,
  createSettingsRadioRow,
} from './settings-controls';
import { createSettingsToggleRow } from './settings-switch';
import { setStatus } from './status';
import { openWorkspaceFolderPicker } from './workspace-folder-picker';
import '../styles/settings-backup.css';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function section(mount: HTMLElement, title: string, lead: string, searchKey: string): HTMLElement {
  const node = el('section', 'backup-section');
  node.dataset.settingsSearchKey = searchKey;
  node.appendChild(el('h4', 'backup-section__title', title));
  node.appendChild(el('p', 'backup-section__lead', lead));
  mount.appendChild(node);
  return node;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Folder row: a path field with the in-app folder browser beside it. */
function createFolderRow(
  label: string,
  options: { value: string; description: string; searchKey?: string; onCommit: (dir: string) => void },
): { row: HTMLElement; input: HTMLInputElement } {
  const { row, input } = createSettingsInputRow(label, {
    value: options.value,
    description: options.description,
    searchKey: options.searchKey,
    spellcheck: false,
    placeholder: 'Choose a folder',
  });
  input.classList.add('backup-path-input');
  let committed = options.value;
  const commit = (): void => {
    const next = input.value.trim();
    if (next === committed) return;
    committed = next;
    options.onCommit(next);
  };
  input.addEventListener('change', commit);

  const choose = el('button', 'settings-inline-btn', 'Choose…');
  choose.type = 'button';
  choose.addEventListener('click', () => {
    void (async () => {
      const picked = await openWorkspaceFolderPicker({
        initialPath: input.value.trim(),
        title: 'Choose backup folder',
        confirmVerb: 'Choose',
      });
      if (picked.cancelled || !picked.path) return;
      input.value = picked.path;
      commit();
    })();
  });
  const control = row.querySelector('.settings-row__control');
  control?.classList.add('backup-inline-control');
  control?.appendChild(choose);
  return { row, input };
}

/** Render the Backup and restore group body. */
export async function renderBackupSettings(mount: HTMLElement): Promise<void> {
  const serverUp = await detectConfigServer();
  if (serverUp !== 'server') {
    appendSettingsOfflineHint(mount, 'Backups need Minnow running on this computer. Open Minnow, then reopen Settings.');
    return;
  }

  let status: BackupStatus;
  try {
    status = await fetchBackupStatus();
  } catch (err) {
    appendSettingsOfflineHint(
      mount,
      err instanceof BackupApiError && /host session/i.test(err.message)
        ? 'Backups are managed on the computer that runs Minnow, not from a paired device.'
        : errorText(err, 'Backup settings could not be loaded.'),
    );
    return;
  }

  const shell = el('div', 'backup-settings');
  mount.appendChild(shell);

  const notices = el('div', 'backup-notices');
  shell.appendChild(notices);

  const selected = new Set(status.settings.categories);
  const applySettings = (settings: BackupSettings): void => {
    status = { ...status, settings };
  };
  const refresh = async (): Promise<void> => {
    try {
      status = await fetchBackupStatus();
    } catch {
      return;
    }
    renderNotices();
    renderSnapshotStatus();
    renderRestoreHistory();
  };

  // ── Notices: last backup, a restore waiting for a restart ──────────────────

  function restartButton(): { label: string; variant: 'primary'; title: string; onClick: () => void }[] {
    const restart = window.minnow?.app?.restart;
    if (!status.packaged || typeof restart !== 'function') return [];
    return [
      {
        label: 'Restart Minnow',
        variant: 'primary',
        title: 'Active sessions will close and Minnow will reopen.',
        onClick: () => void restart(),
      },
    ];
  }

  function renderNotices(): void {
    notices.replaceChildren();
    const { lastExport } = status.settings;
    const summary = lastExport
      ? `Last backup: ${formatBackupWhen(lastExport.at)} · ${backupFileName(lastExport.file)} · ${formatBackupBytes(lastExport.archiveBytes)}${lastExport.encrypted ? ' · encrypted' : ''}`
      : 'No backup yet. Chats, Brain and credentials exist only in the Minnow data folder on this computer.';
    notices.appendChild(backupNote(lastExport ? 'info' : 'warn', summary));

    const pending = status.restore.pending;
    if (!pending) return;
    const what = pending.kind === 'rollback' ? 'undo' : 'restore';
    const notice = el('div', 'backup-notice');
    if (pending.failed) {
      notice.appendChild(
        backupNote(
          'danger',
          `The ${what} could not be applied and Minnow stopped trying. Your data is unchanged. ${pending.lastError}`,
        ),
      );
    } else if (pending.attempts > 0) {
      notice.appendChild(
        backupNote(
          'warn',
          `The ${what} could not be applied at the last start and will be tried again. Your data is unchanged. ${pending.lastError}`,
        ),
      );
    } else {
      const canRestart = restartButton().length > 0;
      notice.appendChild(
        backupNote(
          'ok',
          pending.kind === 'rollback'
            ? `Undo is ready. ${canRestart ? 'Restart Minnow' : 'Quit Minnow and start it again'} to put your previous data back.`
            : `A restore from ${formatBackupWhen(pending.archive?.createdAt)} is unpacked and checked. ${canRestart ? 'Restart Minnow' : 'Quit Minnow and start it again'} to switch to it.`,
        ),
      );
    }
    for (const warning of pending.warnings) notice.appendChild(backupNote('warn', warning));
    notice.appendChild(
      createSettingsActionsRow([
        ...(pending.failed
          ? [
              {
                label: 'Try again at next start',
                onClick: () => void act(() => retryPendingRestore(), 'It will be tried again at the next start'),
              },
            ]
          : restartButton()),
        {
          label: pending.kind === 'rollback' ? 'Cancel undo' : 'Cancel restore',
          onClick: () => void act(() => cancelPendingRestore(), 'Cancelled'),
        },
      ]),
    );
    notices.appendChild(notice);
  }

  async function act(run: () => Promise<unknown>, okMessage: string): Promise<void> {
    try {
      await run();
      setStatus('ok', okMessage);
    } catch (err) {
      setStatus('err', errorText(err, 'That did not work'));
    }
    await refresh();
  }

  // ── What to include ────────────────────────────────────────────────────────

  const contents = section(
    shell,
    'What to include',
    'Used for manual backups and scheduled snapshots. Caches, logs, installed runtimes and git worktrees are never backed up.',
    'general.backup.contents',
  );
  const checklist = el('div', 'settings-checklist backup-checklist');
  checklist.setAttribute('role', 'group');
  checklist.setAttribute('aria-label', 'What to include in backups');
  const sizeCells = new Map<string, HTMLElement>();
  for (const category of status.categories) {
    const option = el('label', 'settings-checklist__option backup-checklist__option');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = selected.has(category.id);
    input.dataset.backupCategory = category.id;
    input.addEventListener('change', () => {
      void (async () => {
        if (input.checked) selected.add(category.id);
        else selected.delete(category.id);
        if (selected.size === 0) {
          selected.add(category.id);
          input.checked = true;
          setStatus('err', 'Keep at least one thing in the backup');
          return;
        }
        try {
          applySettings(await saveBackupSettings({ categories: [...selected] }));
          setStatus('ok', 'Backup contents saved');
        } catch (err) {
          if (input.checked) selected.delete(category.id);
          else selected.add(category.id);
          input.checked = selected.has(category.id);
          setStatus('err', errorText(err, 'Could not save backup contents'));
        }
        renderTotal();
        syncCredentialNote();
      })();
    });
    const text = el('span', 'backup-checklist__text');
    text.appendChild(el('span', 'settings-checklist__label-text', category.label));
    text.appendChild(el('span', 'backup-checklist__desc', category.description));
    option.append(input, text);
    if (category.requiresPassphrase) {
      option.appendChild(el('span', 'backup-checklist__tag', 'Needs a passphrase'));
    }
    const size = el('span', 'backup-checklist__size', '…');
    sizeCells.set(category.id, size);
    option.appendChild(size);
    checklist.appendChild(option);
  }
  contents.appendChild(checklist);
  const total = el('p', 'backup-total');
  contents.appendChild(total);

  let sizes: BackupCategorySize[] | null = null;
  function renderTotal(): void {
    if (!sizes) {
      total.textContent = 'Measuring…';
      return;
    }
    const bytes = sizes.filter((row) => selected.has(row.id)).reduce((sum, row) => sum + row.bytes, 0);
    total.textContent = `About ${formatBackupBytes(bytes)} before compression.`;
  }
  renderTotal();
  void fetchBackupSizes().then(
    (rows) => {
      sizes = rows;
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const [id, cell] of sizeCells) cell.textContent = formatBackupBytes(byId.get(id)?.bytes ?? 0);
      renderTotal();
    },
    () => {
      for (const cell of sizeCells.values()) cell.textContent = '';
      total.textContent = '';
    },
  );

  // ── Back up now ────────────────────────────────────────────────────────────

  const create = section(
    shell,
    'Back up now',
    'Writes one .mnbak file. Safe to run while you work.',
    'general.backup.create',
  );
  const { row: passRow, input: passInput } = createSettingsInputRow('Passphrase', {
    type: 'password',
    autocomplete: 'new-password',
    id: 'settingsBackupPassphrase',
    description: `Optional. Encrypts the backup. At least ${status.minPassphraseLength} characters.`,
  });
  const { row: confirmRow, input: confirmInput } = createSettingsInputRow('Confirm passphrase', {
    type: 'password',
    autocomplete: 'new-password',
    id: 'settingsBackupPassphraseConfirm',
  });
  // Read from the field when the backup starts; nothing is saved until one succeeds.
  const folder = createFolderRow('Save to', {
    value: status.settings.lastDestDir || status.defaultDir,
    description: 'Somewhere other than this disk is best: an external drive or a synced folder.',
    onCommit: () => {},
  });
  const credentialNote = backupNote(
    'warn',
    'Without a passphrase this backup leaves out your API keys, sign-in tokens, scheduled-job prompts and the encryption key. You would enter them again after restoring on another computer.',
  );
  const createFeedback = el('div', 'backup-restore__feedback');
  const createActions = createSettingsActionsRow(
    [{ label: 'Create backup', variant: 'primary', id: 'settingsBackupCreateBtn' }],
    { searchKey: 'general.backup.create' },
  );
  const createBtn = createActions.querySelector<HTMLButtonElement>('#settingsBackupCreateBtn')!;
  create.append(passRow, confirmRow, folder.row, credentialNote, createActions, createFeedback);

  function syncCredentialNote(): void {
    credentialNote.hidden = !selected.has(status.credentialsCategory) || passInput.value.length > 0;
  }
  passInput.addEventListener('input', syncCredentialNote);
  syncCredentialNote();

  createBtn.addEventListener('click', () => {
    void (async () => {
      createFeedback.replaceChildren();
      const passphrase = passInput.value;
      if (passphrase && passphrase.length < status.minPassphraseLength) {
        createFeedback.appendChild(
          backupNote('danger', `Use a passphrase of at least ${status.minPassphraseLength} characters.`),
        );
        return;
      }
      if (passphrase !== confirmInput.value) {
        createFeedback.appendChild(backupNote('danger', 'The two passphrases do not match.'));
        return;
      }
      const dir = folder.input.value.trim();
      if (!dir) {
        createFeedback.appendChild(backupNote('danger', 'Choose a folder to save the backup in.'));
        return;
      }

      createBtn.disabled = true;
      const progress = createBackupProgress();
      progress.set(0, 'Starting…');
      createFeedback.appendChild(progress.root);
      try {
        const job = await startBackupExport({ destDir: dir, categories: [...selected], passphrase });
        const finished = await waitForBackupJob(job, (current) => {
          progress.set(
            backupProgressPercent(current.progress),
            `${current.progress.files.toLocaleString()} of ${current.progress.totalFiles.toLocaleString()} files`,
          );
        });
        if (finished.status !== 'done' || !finished.result) {
          throw new BackupApiError(finished.error || 'The backup failed.', finished.errorCode);
        }
        const result = finished.result;
        createFeedback.replaceChildren(
          backupNote(
            'ok',
            `Backup saved to ${result.file} (${formatBackupBytes(result.archiveBytes)}, ${result.encrypted ? 'encrypted' : 'not encrypted'}).` +
              (result.encrypted ? ' Keep the passphrase somewhere safe: Minnow cannot recover it.' : ''),
          ),
        );
        passInput.value = '';
        confirmInput.value = '';
        syncCredentialNote();
        setStatus('ok', 'Backup created');
        await refresh();
      } catch (err) {
        createFeedback.replaceChildren(backupNote('danger', errorText(err, 'The backup failed.')));
        setStatus('err', 'Backup failed');
      } finally {
        createBtn.disabled = false;
      }
    })();
  });

  // ── Scheduled snapshots ────────────────────────────────────────────────────

  const schedule = section(
    shell,
    'Scheduled snapshots',
    'Minnow writes a snapshot on its own and keeps only the newest few. A failed snapshot shows up in notifications.',
    'general.backup.schedule',
  );

  async function saveSchedule(
    patch: NonNullable<Parameters<typeof saveBackupSettings>[0]['schedule']>,
    okMessage: string,
  ): Promise<boolean> {
    try {
      applySettings(await saveBackupSettings({ schedule: patch }));
      setStatus('ok', okMessage);
      renderSnapshotStatus();
      return true;
    } catch (err) {
      setStatus('err', errorText(err, 'Could not save snapshot settings'));
      return false;
    }
  }

  const { row: enabledRow, input: enabledInput } = createSettingsToggleRow('Take snapshots automatically', {
    id: 'settingsBackupScheduleEnabled',
    checked: status.settings.schedule.enabled,
    description: 'Runs while Minnow is open, including when it is in the tray.',
    searchKey: 'general.backup.schedule',
  });
  const snapshotFolder = createFolderRow('Snapshot folder', {
    value: status.settings.schedule.destDir,
    description: 'Snapshots older than the newest few are deleted from this folder. Other files in it are left alone.',
    onCommit: (dir) => {
      void (async () => {
        if (!(await saveSchedule({ destDir: dir }, 'Snapshot folder saved'))) {
          snapshotFolder.input.value = status.settings.schedule.destDir;
        }
      })();
    },
  });
  enabledInput.addEventListener('change', () => {
    void (async () => {
      const patch: { enabled: boolean; destDir?: string } = { enabled: enabledInput.checked };
      if (enabledInput.checked && !status.settings.schedule.destDir) {
        // Turning it on is the common first step; start with the folder already in use.
        patch.destDir = snapshotFolder.input.value.trim() || folder.input.value.trim() || status.defaultDir;
      }
      const ok = await saveSchedule(
        patch,
        enabledInput.checked ? 'Scheduled snapshots are on' : 'Scheduled snapshots are off',
      );
      if (!ok) enabledInput.checked = status.settings.schedule.enabled;
      snapshotFolder.input.value = status.settings.schedule.destDir;
    })();
  });

  const frequency = createSettingsRadioRow('How often', {
    name: 'settings-backup-frequency',
    options: [
      { value: 'daily', label: 'Daily' },
      { value: 'weekly', label: 'Weekly' },
    ],
    value: status.settings.schedule.frequency,
    onChange: (value) => {
      void (async () => {
        if (!(await saveSchedule({ frequency: value as SnapshotFrequency }, 'Snapshot schedule saved'))) {
          frequency.setValue(status.settings.schedule.frequency);
        }
      })();
    },
  });

  const { row: keepRow, input: keepInput } = createSettingsInputRow('Snapshots to keep', {
    type: 'number',
    id: 'settingsBackupKeep',
    min: String(status.keepRange.min),
    max: String(status.keepRange.max),
    step: '1',
    value: String(status.settings.schedule.keep),
    inputClassName: 'settings-input settings-input--narrow',
  });
  keepInput.addEventListener('change', () => {
    void (async () => {
      const keep = Math.round(Number(keepInput.value));
      if (!(await saveSchedule({ keep }, 'Snapshot retention saved'))) {
        keepInput.value = String(status.settings.schedule.keep);
      }
    })();
  });

  // Snapshot passphrase: saved encrypted, so it is set and removed, never shown.
  const passphraseRow = el('div', 'settings-row');
  const passphraseLabel = el('div', 'settings-row__label');
  passphraseLabel.appendChild(el('span', 'settings-row__title', 'Snapshot passphrase'));
  const passphraseStatus = el('span', 'settings-row__desc');
  passphraseLabel.appendChild(passphraseStatus);
  const passphraseControl = el('div', 'settings-row__control backup-inline-control');
  const setPassBtn = el('button', 'settings-inline-btn');
  setPassBtn.type = 'button';
  const removePassBtn = el('button', 'settings-inline-btn', 'Remove');
  removePassBtn.type = 'button';
  passphraseControl.append(setPassBtn, removePassBtn);
  passphraseRow.append(passphraseLabel, passphraseControl);

  const passphraseForm = el('div', 'backup-passphrase-form');
  passphraseForm.hidden = true;
  const { row: snapPassRow, input: snapPassInput } = createSettingsInputRow('New passphrase', {
    type: 'password',
    autocomplete: 'new-password',
    description: `At least ${status.minPassphraseLength} characters. You need it to restore; Minnow cannot recover it.`,
  });
  const { row: snapConfirmRow, input: snapConfirmInput } = createSettingsInputRow('Confirm passphrase', {
    type: 'password',
    autocomplete: 'new-password',
  });
  const passphraseFeedback = el('div', 'backup-restore__feedback');
  const closePassphraseForm = (): void => {
    passphraseForm.hidden = true;
    snapPassInput.value = '';
    snapConfirmInput.value = '';
    passphraseFeedback.replaceChildren();
  };
  passphraseForm.append(
    snapPassRow,
    snapConfirmRow,
    passphraseFeedback,
    createSettingsActionsRow([
      {
        label: 'Save passphrase',
        variant: 'primary',
        onClick: () => {
          void (async () => {
            passphraseFeedback.replaceChildren();
            if (snapPassInput.value.length < status.minPassphraseLength) {
              passphraseFeedback.appendChild(
                backupNote('danger', `Use a passphrase of at least ${status.minPassphraseLength} characters.`),
              );
              return;
            }
            if (snapPassInput.value !== snapConfirmInput.value) {
              passphraseFeedback.appendChild(backupNote('danger', 'The two passphrases do not match.'));
              return;
            }
            if (await saveSchedule({ passphrase: snapPassInput.value }, 'Snapshot passphrase saved')) {
              closePassphraseForm();
              syncPassphraseRow();
            }
          })();
        },
      },
      { label: 'Cancel', onClick: closePassphraseForm },
    ]),
  );
  setPassBtn.addEventListener('click', () => {
    passphraseForm.hidden = false;
    snapPassInput.focus();
  });
  removePassBtn.addEventListener('click', () => {
    void (async () => {
      const ok = await appConfirm(
        'Remove the snapshot passphrase?\n\nNew snapshots will not be encrypted, and will leave out credentials and the encryption key.',
        { confirmLabel: 'Remove' },
      );
      if (!ok) return;
      if (await saveSchedule({ passphrase: null }, 'Snapshot passphrase removed')) syncPassphraseRow();
    })();
  });

  function syncPassphraseRow(): void {
    const has = status.settings.schedule.hasPassphrase;
    passphraseStatus.textContent = has
      ? 'Saved. Snapshots are encrypted and include credentials.'
      : 'None. Snapshots are not encrypted and leave credentials out.';
    setPassBtn.textContent = has ? 'Change' : 'Set passphrase';
    removePassBtn.hidden = !has;
  }
  syncPassphraseRow();

  const snapshotStatus = el('p', 'backup-snapshot-status');
  const snapshotFeedback = el('div', 'backup-restore__feedback');
  const snapshotActions = createSettingsActionsRow([{ label: 'Take snapshot now', id: 'settingsBackupSnapshotBtn' }]);
  const snapshotBtn = snapshotActions.querySelector<HTMLButtonElement>('#settingsBackupSnapshotBtn')!;

  function renderSnapshotStatus(): void {
    const { state, schedule: current } = status.settings;
    snapshotBtn.disabled = !current.destDir;
    snapshotFeedback.querySelector('[data-snapshot-error]')?.remove();
    if (!state.lastRunAt) {
      snapshotStatus.textContent = current.enabled
        ? `No snapshot yet. First one: ${formatBackupWhen(state.nextRunAt)}.`
        : 'No snapshot yet.';
      return;
    }
    const outcome =
      state.lastStatus === 'skipped'
        ? 'nothing had changed'
        : state.lastStatus === 'failed'
          ? 'failed'
          : backupFileName(state.lastFile);
    snapshotStatus.textContent =
      `Last run: ${formatBackupWhen(state.lastRunAt)} (${outcome}).` +
      (current.enabled ? ` Next: ${formatBackupWhen(state.nextRunAt)}.` : '');
    if (state.lastStatus === 'failed' && state.lastError) {
      const note = backupNote('danger', `The last snapshot failed: ${state.lastError}`);
      note.dataset.snapshotError = 'true';
      snapshotFeedback.prepend(note);
    }
  }

  snapshotBtn.addEventListener('click', () => {
    void (async () => {
      snapshotFeedback.replaceChildren();
      snapshotBtn.disabled = true;
      const progress = createBackupProgress();
      progress.set(0, 'Starting…');
      snapshotFeedback.appendChild(progress.root);
      try {
        const job = await startSnapshotNow();
        const finished = await waitForBackupJob(job, (current: BackupJob) => {
          progress.set(
            backupProgressPercent(current.progress),
            `${current.progress.files.toLocaleString()} of ${current.progress.totalFiles.toLocaleString()} files`,
          );
        });
        snapshotFeedback.replaceChildren();
        if (finished.status !== 'done') {
          throw new BackupApiError(finished.error || 'The snapshot failed.', finished.errorCode);
        }
        snapshotFeedback.appendChild(
          backupNote('ok', `Snapshot saved to ${finished.result?.file ?? status.settings.schedule.destDir}.`),
        );
        setStatus('ok', 'Snapshot taken');
      } catch (err) {
        snapshotFeedback.replaceChildren(backupNote('danger', errorText(err, 'The snapshot failed.')));
        setStatus('err', 'Snapshot failed');
      }
      await refresh();
    })();
  });

  schedule.append(
    enabledRow,
    frequency.row,
    snapshotFolder.row,
    keepRow,
    passphraseRow,
    passphraseForm,
    snapshotStatus,
    snapshotActions,
    snapshotFeedback,
  );

  // ── Restore ────────────────────────────────────────────────────────────────

  const restore = section(
    shell,
    'Restore',
    'Bring back a backup on this computer, or move to a new one. Your current data is set aside rather than overwritten, so a restore can be undone.',
    'general.backup.restore',
  );
  const restoreActions = createSettingsActionsRow(
    [{ label: 'Restore from a backup…', id: 'settingsBackupRestoreBtn' }],
    { searchKey: 'general.backup.restore' },
  );
  const restoreBtn = restoreActions.querySelector<HTMLButtonElement>('#settingsBackupRestoreBtn')!;
  const restoreMount = el('div', 'backup-restore-mount');
  const history = el('div', 'backup-notice');
  restore.append(restoreActions, restoreMount, history);

  let panel: RestorePanelHandle | null = null;
  const closePanel = (): void => {
    panel?.destroy();
    panel = null;
    restoreActions.hidden = false;
  };
  restoreBtn.addEventListener('click', () => {
    if (panel) return;
    restoreActions.hidden = true;
    panel = mountRestorePanel(restoreMount, {
      initialDir: status.settings.lastDestDir || status.settings.schedule.destDir || status.defaultDir,
      canRestartInPlace: status.packaged,
      onClose: closePanel,
      // Once a restore is staged the notice at the top takes over: one message, one set of buttons.
      onChanged: () => {
        closePanel();
        void refresh().then(() => notices.scrollIntoView({ block: 'nearest' }));
      },
    });
  });

  function renderRestoreHistory(): void {
    history.replaceChildren();
    // The notice at the top already carries a waiting restore and its buttons.
    if (status.restore.pending && panel === null) restoreActions.hidden = true;
    else if (panel === null) restoreActions.hidden = false;

    const last = status.restore.last;
    if (!last) return;
    if (last.rolledBackAt) {
      history.appendChild(
        el(
          'p',
          'backup-snapshot-status',
          `The restore of ${formatBackupWhen(last.appliedAt)} was undone on ${formatBackupWhen(last.rolledBackAt)}.`,
        ),
      );
      return;
    }
    history.appendChild(
      el(
        'p',
        'backup-snapshot-status',
        `Last restore: ${formatBackupWhen(last.appliedAt)}, from the backup of ${formatBackupWhen(last.archive?.createdAt)}.` +
          (last.canUndo ? ` Previous data kept: ${formatBackupBytes(last.previousDataBytes)}.` : ''),
      ),
    );
    if (last.keyChanged && last.setAside > 0) {
      history.appendChild(
        backupNote(
          'warn',
          `That backup brought a different encryption key, so ${last.setAside} encrypted ${last.setAside === 1 ? 'file' : 'files'} it did not replace ${last.setAside === 1 ? 'was' : 'were'} set aside with the previous data.`,
        ),
      );
    }
    if (!last.canUndo || status.restore.pending) return;
    history.appendChild(
      createSettingsActionsRow([
        {
          label: 'Undo restore',
          onClick: () => {
            void (async () => {
              const ok = await appConfirm(
                'Undo the last restore?\n\nThe data you had before it comes back the next time Minnow starts. Anything created since the restore is removed.',
                { confirmLabel: 'Undo restore' },
              );
              if (ok) await act(() => undoLastRestore(), 'Undo is ready for the next start');
            })();
          },
        },
        {
          label: 'Delete previous data',
          variant: 'danger',
          onClick: () => {
            void (async () => {
              const ok = await appConfirm(
                `Delete the data kept from before the restore (${formatBackupBytes(last.previousDataBytes)})?\n\nThe restore can no longer be undone.`,
                { confirmLabel: 'Delete', danger: true },
              );
              if (ok) await act(() => discardPreviousData(), 'Previous data deleted');
            })();
          },
        },
      ]),
    );
  }

  renderNotices();
  renderSnapshotStatus();
  renderRestoreHistory();
}
